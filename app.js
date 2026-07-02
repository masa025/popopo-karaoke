// Application Logic for POPOPO SparkleScore Live

document.addEventListener('DOMContentLoaded', () => {
  // Global Variables & Config
  let socket;
  let currentRole = null; // 'streamer' or 'listener'
  let roomId = 'live-session';
  let isConnected = false;

  // Streamer Side Variables
  let lyricsData = [];
  let songStartTime = 0;
  let isSongPlaying = false;
  let audioCtx = null;
  let activeOscillators = [];
  let currentLyricIndex = -1;
  let currentScore = 0; // Starts at 0, builds up
  let targetScore = 0;
  let animationFrameId = null;
  
  // Real-time listener states accumulated on streamer side
  let streamerViewerCount = 0;
  let simulatedPitchAccuracy = 85; // %
  let simulatedVolume = 70; // %

  // --- Reaction Heat Engine (Streamer Side) ---
  const REACTION_WEIGHTS = { tear: 3, goosebumps: 4, god: 5, popopo: 2 };
  const REACTION_META = {
    tear: ['😭', '泣ける'],
    goosebumps: ['⚡', '鳥肌'],
    god: ['✨', '神歌声'],
    popopo: ['🎉', 'POPOPO!']
  };
  const HEAT_TAU = 8;    // Exponential decay time constant (seconds) => half-life ~5.5s
  const HEAT_GAIN = 1.7; // Points-per-tap scaling factor
  let heat = 0;                       // Current heat gauge 0-100
  let lastHeatUpdate = Date.now();
  let recentReactions = [];           // Rolling 3s window for sync-combo detection
  let listenerTapHistory = new Map(); // socketId -> recent tap timestamps (diminishing returns)
  let momentLog = [];                 // Timestamped reactions during the song (highlights)
  let heatCurve = [];                 // Sampled { t, heat, score } curve for the result waveform
  let lastCurveSample = -1;
  let scoreSampleSum = 0;
  let scoreSampleCount = 0;
  let lastAvgLiveScore = 0;
  let starRatings = new Map();        // listenerId -> stars (1-5)
  let reactionTotals = { tear: 0, goosebumps: 0, god: 0, popopo: 0 };
  let songHadRun = false;
  let lastHighlight = null;
  let syncBadgeTimeout = null;

  // Particles System Configurations
  let stageCanvas, stageCtx;
  let particles = [];
  let waves = [];

  // Listener Side Variables
  let listenerCanvas, listenerCtx;
  let listenerParticles = [];
  let tapCounts = {};        // Per-reaction tap counters (badges)
  let tapTimestamps = [];    // Rolling 1s window for local rate limiting
  let comboCount = 0;        // Local rapid-tap streak
  let lastTapAt = 0;
  let hasRatedThisSong = false;

  // Initialize Canvas Wave Structures (Streamer View)
  class Wave {
    constructor(color, speed, amplitude, frequency, offset) {
      this.color = color;
      this.speed = speed;
      this.amplitude = amplitude;
      this.frequency = frequency;
      this.offset = offset;
      this.phase = Math.random() * 100;
    }
    update(volume, emotion) {
      this.phase += this.speed * (0.5 + volume * 0.01);
      // Amplitude scales with volume, frequency shifts slightly with emotion
      this.currentAmp = this.amplitude * (0.3 + (volume * 0.007)) * (0.8 + emotion * 0.005);
    }
    draw(ctx, width, height, coreY) {
      ctx.beginPath();
      ctx.strokeStyle = this.color;
      ctx.lineWidth = 2.5;
      
      // Shadow glow for neon look
      ctx.shadowBlur = 15;
      ctx.shadowColor = this.color;

      for (let x = 0; x < width; x += 5) {
        const angle = (x / width) * Math.PI * 2 * this.frequency + this.phase + this.offset;
        const y = coreY + Math.sin(angle) * this.currentAmp;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0; // Reset
    }
  }

  // Particle Class for beautiful Canvas animations
  class Particle {
    constructor(x, y, targetX, targetY, type, scale = 1) {
      this.x = x;
      this.y = y;
      this.targetX = targetX;
      this.targetY = targetY;
      this.type = type; // 'tear', 'goosebumps', 'god', 'popopo', 'perfect'
      this.scale = scale;
      
      const angle = Math.atan2(targetY - y, targetX - x);
      const dist = Math.hypot(targetX - x, targetY - y);
      const speedFactor = 0.02 + Math.random() * 0.025;
      
      this.vx = Math.cos(angle) * dist * speedFactor + (Math.random() - 0.5) * 4;
      this.vy = Math.sin(angle) * dist * speedFactor + (Math.random() - 0.5) * 4;
      
      this.life = 1.0;
      this.decay = 0.015 + Math.random() * 0.015;
      this.size = (3 + Math.random() * 6) * scale;
      
      // Determine colors based on emotional type
      switch(type) {
        case 'tear': // Blue tears
          this.colors = ['#60a5fa', '#3b82f6', '#1d4ed8'];
          break;
        case 'goosebumps': // Golden lightning sparks
          this.colors = ['#fbbf24', '#f59e0b', '#d97706'];
          break;
        case 'god': // Purple celestial stars
          this.colors = ['#c084fc', '#a855f7', '#7e22ce'];
          break;
        case 'popopo': // Pink festive fireworks
          this.colors = ['#f472b6', '#ec4899', '#be185d'];
          break;
        case 'perfect': // Emerald sparks for pitch matches
          this.colors = ['#34d399', '#10b981', '#047857'];
          this.size = (2 + Math.random() * 4) * scale;
          break;
        default:
          this.colors = ['#ffffff', '#f3f4f6'];
      }
      this.color = this.colors[Math.floor(Math.random() * this.colors.length)];
    }

    update() {
      // Pull particles toward the target
      if (this.targetX !== null) {
        const dx = this.targetX - this.x;
        const dy = this.targetY - this.y;
        const dist = Math.hypot(dx, dy);
        
        if (dist > 15) {
          this.vx += (dx / dist) * 0.4;
          this.vy += (dy / dist) * 0.4;
          // Apply friction
          this.vx *= 0.95;
          this.vy *= 0.95;
        } else {
          // Arrived! Disperse as explosion
          this.life = 0; // Trigger explosion check
          return false;
        }
      }
      
      this.x += this.vx;
      this.y += this.vy;
      this.life -= this.decay;
      return this.life > 0;
    }

    draw(ctx) {
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size * this.life, 0, Math.PI * 2);
      ctx.fillStyle = this.color;
      
      // Neon glow
      ctx.shadowBlur = 10;
      ctx.shadowColor = this.color;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  // Explosion Particle Class
  class Sparkle {
    constructor(x, y, color) {
      this.x = x;
      this.y = y;
      this.vx = (Math.random() - 0.5) * 8;
      this.vy = (Math.random() - 0.5) * 8;
      this.color = color;
      this.size = 2 + Math.random() * 3;
      this.life = 1.0;
      this.decay = 0.03 + Math.random() * 0.03;
    }
    update() {
      this.x += this.vx;
      this.y += this.vy;
      this.vy += 0.1; // Tiny gravity
      this.life -= this.decay;
      return this.life > 0;
    }
    draw(ctx) {
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size * this.life, 0, Math.PI * 2);
      ctx.fillStyle = this.color;
      ctx.fill();
    }
  }

  // UI Navigation Elements
  const selectionScreen = document.getElementById('selection-screen');
  const streamerScreen = document.getElementById('streamer-screen');
  const listenerScreen = document.getElementById('listener-screen');
  const listenerRoomInput = document.getElementById('listener-room-input');
  
  // Modals & QR Elements
  const qrModal = document.getElementById('qr-modal');
  const shareUrlInput = document.getElementById('share-url-input');
  const qrcodeContainer = document.getElementById('qrcode-container');
  let qrcodeObj = null;

  // --- Router / Param Parsing ---
  const urlParams = new URLSearchParams(window.location.search);
  const paramRole = urlParams.get('role');
  const paramRoom = urlParams.get('room');

  if (paramRoom) roomId = paramRoom;

  if (paramRole === 'streamer') {
    startStreamerRole();
  } else if (paramRole === 'listener') {
    startListenerRole();
  }

  // --- Selection Screen Interaction ---
  document.getElementById('btn-select-streamer').addEventListener('click', () => {
    // Navigate to Streamer Role
    window.history.pushState({}, '', `?role=streamer&room=${roomId}`);
    startStreamerRole();
  });

  document.getElementById('btn-select-listener').addEventListener('click', () => {
    // Show Room Input Panel
    document.getElementById('btn-select-streamer').style.display = 'none';
    document.getElementById('btn-select-listener').style.display = 'none';
    listenerRoomInput.style.display = 'flex';
  });

  document.getElementById('btn-back-selection').addEventListener('click', () => {
    document.getElementById('btn-select-streamer').style.display = 'block';
    document.getElementById('btn-select-listener').style.display = 'block';
    listenerRoomInput.style.display = 'none';
  });

  document.getElementById('btn-join-room').addEventListener('click', () => {
    const inputId = document.getElementById('input-room-id').value.trim();
    if (inputId) roomId = inputId;
    window.history.pushState({}, '', `?role=listener&room=${roomId}`);
    startListenerRole();
  });

  // --- Start Streamer Role Implementation ---
  function startStreamerRole() {
    currentRole = 'streamer';
    selectionScreen.classList.remove('active');
    streamerScreen.classList.add('active');
    
    // Connect WebSockets
    initSocketConnection();

    // Setup Canvas
    stageCanvas = document.getElementById('stage-canvas');
    stageCtx = stageCanvas.getContext('2d');
    resizeStageCanvas();
    window.addEventListener('resize', resizeStageCanvas);

    // Initialize Wave Visuals
    waves = [
      new Wave('rgba(168, 85, 247, 0.4)', 0.02, 60, 1.5, 0), // Violet
      new Wave('rgba(59, 130, 246, 0.35)', 0.015, 80, 2.2, Math.PI / 4), // Blue
      new Wave('rgba(236, 72, 153, 0.3)', 0.025, 40, 3.0, Math.PI / 2) // Pink
    ];

    // Load Lyrics data
    fetch('lyrics.json')
      .then(res => res.json())
      .then(data => {
        lyricsData = data;
        renderPitchGuideTrack();
      })
      .catch(err => console.error('Failed to load lyrics data:', err));

    // UI Bindings (Streamer Controls)
    document.getElementById('btn-start-demo-song').addEventListener('click', startSongDemo);
    document.getElementById('btn-stop-demo-song').addEventListener('click', stopSongDemo);
    
    // Sim sliders
    const simPitchSlider = document.getElementById('slider-sim-pitch');
    simPitchSlider.addEventListener('input', (e) => {
      simulatedPitchAccuracy = parseInt(e.target.value);
      document.getElementById('sim-pitch-val').innerText = `${simulatedPitchAccuracy}%`;
    });
    
    const simVolSlider = document.getElementById('slider-sim-volume');
    simVolSlider.addEventListener('input', (e) => {
      simulatedVolume = parseInt(e.target.value);
      document.getElementById('sim-volume-val').innerText = `${simulatedVolume}%`;
    });

    // QR Code generation Setup
    document.getElementById('btn-toggle-qr').addEventListener('click', showInviteModal);
    document.getElementById('btn-close-qr').addEventListener('click', hideInviteModal);
    document.getElementById('btn-copy-url').addEventListener('click', copyShareURL);

    // Result modal close
    document.getElementById('btn-close-result').addEventListener('click', () => {
      document.getElementById('result-modal').classList.remove('active');
    });

    // Start Streamer rendering loop
    tickStreamer();
  }

  function resizeStageCanvas() {
    stageCanvas.width = stageCanvas.parentElement.clientWidth;
    stageCanvas.height = stageCanvas.parentElement.clientHeight;
  }

  function showInviteModal() {
    const localIP = window.location.hostname;
    const port = window.location.port ? `:${window.location.port}` : '';
    const shareURL = `${window.location.protocol}//${localIP}${port}/?role=listener&room=${roomId}`;
    
    shareUrlInput.value = shareURL;
    qrModal.classList.add('active');

    // Make QR Code
    if (!qrcodeObj) {
      qrcodeObj = new QRCode(qrcodeContainer, {
        text: shareURL,
        width: 180,
        height: 180,
        colorDark: "#070913",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.H
      });
    } else {
      qrcodeObj.clear();
      qrcodeObj.makeCode(shareURL);
    }
  }

  function hideInviteModal() {
    qrModal.classList.remove('active');
  }

  function copyShareURL() {
    shareUrlInput.select();
    document.execCommand('copy');
    const copyBtn = document.getElementById('btn-copy-url');
    copyBtn.innerText = 'コピー済';
    copyBtn.classList.remove('btn-accent');
    copyBtn.classList.add('btn-secondary');
    setTimeout(() => {
      copyBtn.innerText = 'コピー';
      copyBtn.classList.remove('btn-secondary');
      copyBtn.classList.add('btn-accent');
    }, 1500);
  }

  // --- Start Listener Role Implementation ---
  function startListenerRole() {
    currentRole = 'listener';
    selectionScreen.classList.remove('active');
    listenerScreen.classList.add('active');

    // Setup Local Particles Canvas
    listenerCanvas = document.getElementById('listener-particle-canvas');
    listenerCtx = listenerCanvas.getContext('2d');
    resizeListenerCanvas();
    window.addEventListener('resize', resizeListenerCanvas);

    // Setup Reaction Buttons (rapid-tap friendly)
    document.querySelectorAll('.reaction-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const now = Date.now();

        // Local rate limit: max 8 taps/sec across all buttons
        tapTimestamps = tapTimestamps.filter(t => now - t < 1000);
        if (tapTimestamps.length >= 8) return;
        tapTimestamps.push(now);

        const rect = btn.getBoundingClientRect();
        const reactionType = btn.getAttribute('data-reaction');

        // Update tap count badge
        tapCounts[reactionType] = (tapCounts[reactionType] || 0) + 1;
        const countEl = document.getElementById(`count-${reactionType}`);
        if (countEl) countEl.innerText = tapCounts[reactionType];

        // Tap pop animation (restartable)
        btn.classList.remove('tapped');
        void btn.offsetWidth;
        btn.classList.add('tapped');

        // Local rapid-tap combo streak (chains while taps are <900ms apart)
        comboCount = (now - lastTapAt < 900) ? comboCount + 1 : 1;
        lastTapAt = now;
        updateComboIndicator();

        // Spark particles locally at button location
        createLocalListenerParticles(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
          reactionType
        );

        // Send reaction to server
        sendReaction(reactionType);
      });
    });

    // Star Rating buttons (final evaluation after the song)
    document.querySelectorAll('.star-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (hasRatedThisSong) return;
        const stars = parseInt(btn.getAttribute('data-stars'));

        // Light up stars visually
        document.querySelectorAll('.star-btn').forEach(b => {
          b.classList.toggle('lit', parseInt(b.getAttribute('data-stars')) <= stars);
        });

        hasRatedThisSong = true;
        if (isConnected && socket) {
          socket.emit('final-rating', { roomId, stars });
        }
        document.getElementById('rating-thanks').style.display = 'block';
        setTimeout(() => {
          document.getElementById('rating-overlay').classList.remove('active');
        }, 1200);
      });
    });

    // Listener result card close
    document.getElementById('btn-close-listener-result').addEventListener('click', () => {
      document.getElementById('listener-result-overlay').classList.remove('active');
    });

    // Connect WebSockets
    initSocketConnection();

    // Start Listener render loop
    tickListener();
  }

  function resizeListenerCanvas() {
    listenerCanvas.width = window.innerWidth;
    listenerCanvas.height = window.innerHeight;
  }

  function updateComboIndicator() {
    const el = document.getElementById('combo-indicator');
    if (!el) return;
    el.innerText = `x${Math.max(1, comboCount)}`;
    el.classList.toggle('hot', comboCount >= 5);
  }

  // --- WebSocket Connection ---
  function initSocketConnection() {
    try {
      socket = io();

      socket.on('connect', () => {
        isConnected = true;
        console.log('Connected to server!');
        // Join the session
        socket.emit('join-room', { roomId, role: currentRole });
      });

      // Streamer Listeners
      if (currentRole === 'streamer') {
        socket.on('room-status', ({ listenersCount }) => {
          streamerViewerCount = listenersCount;
          document.getElementById('streamer-viewer-count').innerText = streamerViewerCount;
        });

        socket.on('listener-reaction', ({ listenerId, reactionType }) => {
          // Feed the heat scoring engine (weights, sync combo, moments)
          registerReaction(listenerId, reactionType);

          // Generate a beautiful particle floating towards the center score ring
          const startX = Math.random() * stageCanvas.width;
          const startY = stageCanvas.height + 20; // Float up from bottom
          const targetX = stageCanvas.width / 2;
          const targetY = stageCanvas.height * 0.45; // Target is the score core

          particles.push(new Particle(startX, startY, targetX, targetY, reactionType, 1.5));
        });

        // Final star ratings arriving from listeners after the song
        socket.on('final-rating', ({ listenerId, stars }) => {
          starRatings.set(listenerId, stars);
          updateRatingSummary();
        });
      }

      // Listener Listeners
      if (currentRole === 'listener') {
        socket.on('room-status', ({ listenersCount }) => {
          // Just update UI if we want to show active listener list
        });

        // Live score + heat gauge sync from streamer
        socket.on('global-score-sync', ({ score, heat: globalHeat }) => {
          document.getElementById('listener-score-val').innerText = score.toFixed(1);
          const h = Math.max(0, Math.min(100, globalHeat || 0));
          document.getElementById('heat-value').innerText = Math.round(h);
          document.getElementById('heat-bar-fill').style.width = `${h}%`;
        });

        // Song lifecycle events relayed from the streamer
        socket.on('song-event', ({ event, payload }) => {
          if (event === 'song-start') {
            // Reset per-song state
            hasRatedThisSong = false;
            tapCounts = {};
            Object.keys(REACTION_META).forEach(t => {
              const el = document.getElementById(`count-${t}`);
              if (el) el.innerText = '0';
            });
            document.querySelectorAll('.star-btn').forEach(b => b.classList.remove('lit'));
            document.getElementById('rating-thanks').style.display = 'none';
            document.getElementById('rating-overlay').classList.remove('active');
            document.getElementById('listener-result-overlay').classList.remove('active');
          } else if (event === 'song-end') {
            if (!hasRatedThisSong) {
              document.getElementById('rating-overlay').classList.add('active');
            }
          } else if (event === 'final-result') {
            document.getElementById('listener-final-grade').innerText = payload.grade || '-';
            document.getElementById('listener-final-score').innerText = (payload.finalScore || 0).toFixed(1);
            const starsLine = document.getElementById('listener-final-stars');
            if (payload.avgStars) {
              const full = Math.round(payload.avgStars);
              starsLine.innerText = '★'.repeat(full) + '☆'.repeat(5 - full) + ` ${payload.avgStars.toFixed(1)}`;
            } else {
              starsLine.innerText = '';
            }
            // Only surface the result once this listener has finished rating
            if (hasRatedThisSong) {
              document.getElementById('listener-result-overlay').classList.add('active');
            }
          }
        });
      }

      socket.on('disconnect', () => {
        isConnected = false;
        console.log('Disconnected from server');
      });

    } catch (e) {
      console.warn('Socket.io failed to initialize, running in standalone/offline mode.', e);
    }
  }

  function sendReaction(type) {
    if (isConnected && socket) {
      socket.emit('reaction-send', { roomId, reactionType: type });
    }
  }

  // --- Web Audio API Synth Engine for Amazing Grace ---
  function initAudioContext() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  }

  // Amazing Grace Melody Notes
  // Format: { time: seconds, note: MIDI, duration: seconds }
  // A cappella style hum synthesizer sequence
  const songSequence = [
    { time: 2.0, note: 55, duration: 1.0 }, // G3
    { time: 3.0, note: 60, duration: 2.0 }, // C4
    { time: 5.0, note: 64, duration: 0.5 }, // E4
    { time: 5.5, note: 60, duration: 0.5 }, // C4
    { time: 6.0, note: 64, duration: 2.0 }, // E4
    { time: 8.0, note: 62, duration: 1.0 }, // D4
    { time: 9.0, note: 60, duration: 2.0 }, // C4
    { time: 11.0, note: 57, duration: 1.0 }, // A3
    { time: 12.0, note: 55, duration: 2.0 }, // G3
    
    { time: 14.5, note: 55, duration: 1.0 }, // G3
    { time: 15.5, note: 60, duration: 2.0 }, // C4
    { time: 17.5, note: 64, duration: 0.5 }, // E4
    { time: 18.0, note: 60, duration: 0.5 }, // C4
    { time: 18.5, note: 64, duration: 2.0 }, // E4
    { time: 20.5, note: 62, duration: 1.0 }, // D4
    { time: 21.5, note: 67, duration: 3.0 }, // G4
    
    { time: 25.0, note: 64, duration: 2.0 }, // E4
    { time: 27.0, note: 67, duration: 2.0 }, // G4
    { time: 29.0, note: 64, duration: 0.5 }, // E4
    { time: 29.5, note: 67, duration: 0.5 }, // G4
    { time: 30.0, note: 64, duration: 2.0 }, // E4
    { time: 32.0, note: 60, duration: 1.0 }, // C4
    { time: 33.0, note: 55, duration: 2.0 }, // G3
    { time: 35.0, note: 57, duration: 1.0 }, // A3
    { time: 36.0, note: 55, duration: 1.0 }, // G3
    { time: 37.0, note: 57, duration: 1.0 }, // A3
    { time: 38.0, note: 60, duration: 2.0 }, // C4
    
    { time: 40.5, note: 64, duration: 0.5 }, // E4
    { time: 41.0, note: 60, duration: 0.5 }, // C4
    { time: 41.5, note: 64, duration: 2.0 }, // E4
    { time: 43.5, note: 62, duration: 1.0 }, // D4
    { time: 44.5, note: 60, duration: 3.0 }  // C4
  ];

  function playSynthTone(midiNote, duration, startTime) {
    if (!audioCtx) return;
    const freq = Math.pow(2, (midiNote - 69) / 12) * 440;
    
    // Main vocal wave: Triangle wave for sweet hum
    const osc1 = audioCtx.createOscillator();
    osc1.type = 'triangle';
    osc1.frequency.value = freq;
    
    // Sub harmonic: sine wave for depth
    const osc2 = audioCtx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = freq / 2;

    const gainNode = audioCtx.createGain();
    const filter = audioCtx.createBiquadFilter();
    
    // Low pass filter for soft hum tone
    filter.type = 'lowpass';
    filter.frequency.value = 800;

    // Gain envelope (soft attack & slow release for vocals)
    gainNode.gain.setValueAtTime(0, startTime);
    gainNode.gain.linearRampToValueAtTime(0.2, startTime + 0.15); // soft attack
    gainNode.gain.setValueAtTime(0.2, startTime + duration - 0.2);
    gainNode.gain.exponentialRampToValueAtTime(0.001, startTime + duration); // smooth decay

    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    // Track active oscillators for stopping
    const oscRef = { osc1, osc2, gainNode };
    activeOscillators.push(oscRef);

    osc1.start(startTime);
    osc2.start(startTime);
    
    osc1.stop(startTime + duration);
    osc2.stop(startTime + duration);

    // Cleanup reference after finished
    setTimeout(() => {
      const idx = activeOscillators.indexOf(oscRef);
      if (idx !== -1) activeOscillators.splice(idx, 1);
    }, (startTime + duration - audioCtx.currentTime) * 1000 + 1000);
  }

  function midiToFreq(midi) {
    return Math.pow(2, (midi - 69) / 12) * 440;
  }

  // Visual representation of notes in pitch guide
  function renderPitchGuideTrack() {
    const pitchGuideNotes = document.getElementById('pitch-guide-notes');
    if (!pitchGuideNotes) return;
    pitchGuideNotes.innerHTML = '';
    
    // Map MIDI notes (50 to 70 range) to vertical positions
    const midiMin = 50;
    const midiMax = 70;

    songSequence.forEach(item => {
      const noteBlock = document.createElement('div');
      noteBlock.className = 'pitch-note-block';
      
      // Calculate horizontal positioning: 1 second = 35 pixels
      const left = item.time * 35;
      const width = item.duration * 35;
      
      // Calculate vertical positioning (percentage of guide track height)
      const topPct = 100 - ((item.note - midiMin) / (midiMax - midiMin)) * 80 - 10;
      
      noteBlock.style.left = `${left}px`;
      noteBlock.style.width = `${width}px`;
      noteBlock.style.top = `${topPct}%`;
      noteBlock.setAttribute('data-time', item.time);
      noteBlock.setAttribute('data-duration', item.duration);
      noteBlock.setAttribute('data-note', item.note);
      
      pitchGuideNotes.appendChild(noteBlock);
    });
  }

  // --- Start & Stop Song ---
  function startSongDemo() {
    initAudioContext();
    isSongPlaying = true;
    songStartTime = audioCtx.currentTime;

    // Reset the reaction scoring engine for the new song
    heat = 0;
    lastHeatUpdate = Date.now();
    recentReactions = [];
    listenerTapHistory.clear();
    momentLog = [];
    heatCurve = [];
    lastCurveSample = -1;
    scoreSampleSum = 0;
    scoreSampleCount = 0;
    starRatings.clear();
    reactionTotals = { tear: 0, goosebumps: 0, god: 0, popopo: 0 };
    songHadRun = true;
    document.getElementById('result-modal').classList.remove('active');

    // Notify listeners that a new song has started
    if (isConnected && socket) {
      socket.emit('song-event', { roomId, event: 'song-start' });
    }

    document.getElementById('btn-start-demo-song').disabled = true;
    document.getElementById('btn-stop-demo-song').disabled = false;
    
    // Schedule all synthesizer sounds
    const now = audioCtx.currentTime;
    songSequence.forEach(item => {
      playSynthTone(item.note, item.duration, now + item.time);
    });
  }

  function stopSongDemo() {
    isSongPlaying = false;
    // Stop all playing oscillators immediately
    activeOscillators.forEach(osc => {
      try {
        osc.osc1.stop();
        osc.osc2.stop();
      } catch (e) {}
    });
    activeOscillators = [];
    
    document.getElementById('btn-start-demo-song').disabled = false;
    document.getElementById('btn-stop-demo-song').disabled = true;
    
    // Reset lyrics and pitch indicator
    document.getElementById('current-lyric').innerText = 'Preparing A Cappella...';
    document.getElementById('pitch-player-pointer').style.display = 'none';

    // Show the result flow (star rating on listeners, result modal here)
    if (songHadRun) {
      songHadRun = false;
      if (isConnected && socket) {
        socket.emit('song-event', { roomId, event: 'song-end' });
      }
      showResultModal();
    }
  }

  // --- Score Aggregation & Logic (Streamer Side) ---
  function calculateStreamerScore(elapsedSeconds) {
    // 1. Get pitch accuracy from guide
    let guideNoteMatch = false;
    let expectedMidiNote = 0;
    
    // Find if there is a note currently expected
    for (const item of songSequence) {
      if (elapsedSeconds >= item.time && elapsedSeconds <= (item.time + item.duration)) {
        guideNoteMatch = true;
        expectedMidiNote = item.note;
        break;
      }
    }

    let pitchScoreContribution = 0;
    const pointer = document.getElementById('pitch-player-pointer');
    
    if (guideNoteMatch && isSongPlaying) {
      // Simulate real-time pitch accuracy with slight variance
      const matchQuality = simulatedPitchAccuracy / 100;
      pitchScoreContribution = matchQuality * 100;
      
      pointer.style.display = 'block';
      // Map MIDI note expected to vertical %
      const midiMin = 50;
      const midiMax = 70;
      const verticalVal = 100 - ((expectedMidiNote - midiMin) / (midiMax - midiMin)) * 80 - 10;
      
      // Let the pointer hover near the target based on accuracy
      const deviation = (1 - matchQuality) * 15 * (Math.sin(elapsedSeconds * 5) > 0 ? 1 : -1);
      pointer.style.top = `${verticalVal + deviation}%`;

      if (matchQuality > 0.8) {
        pointer.classList.add('matched');
        // Emit emerald sparkles from matching dot
        if (Math.random() < 0.3) {
          const px = 150; // Pointer fixed X coordinate offset
          const py = (stageCanvas.height - 130) + (pointer.offsetTop / 100) * 70; // Map container relative
          particles.push(new Particle(px, py, null, null, 'perfect', 0.8));
        }
      } else {
        pointer.classList.remove('matched');
      }
    } else {
      pointer.style.display = 'none';
      pitchScoreContribution = 30; // Passive hum score
    }

    // 2. Listener Reaction Heat Contribution (decaying heat gauge)
    updateHeatDecay();
    // Fall back to a neutral 50 when nobody is connected so the solo demo still works
    const audienceContribution = streamerViewerCount > 0 ? heat : 50;

    // 3. Final Aggregated Score calculation
    // formula: 30% pitch accuracy + 50% audience reaction heat + 20% volume/aesthetic factor
    const rawTargetScore = (pitchScoreContribution * 0.3) + (audienceContribution * 0.5) + (simulatedVolume * 0.2);

    // Smooth transition
    targetScore = Math.max(0, Math.min(100, rawTargetScore));
    currentScore += (targetScore - currentScore) * 0.08;

    // Sample curves & running average while the song is playing (for the result screen)
    if (isSongPlaying) {
      scoreSampleSum += currentScore;
      scoreSampleCount++;
      if (elapsedSeconds - lastCurveSample >= 0.5) {
        lastCurveSample = elapsedSeconds;
        heatCurve.push({ t: elapsedSeconds, heat, score: currentScore });
      }
    }

    // Emit global score + heat to listeners
    if (isConnected && socket && Math.random() < 0.15) { // Throttle emissions
      socket.emit('score-sync-relay', { roomId, score: currentScore, heat });
    }
  }

  // --- Reaction Heat Engine Functions ---
  function updateHeatDecay() {
    const now = Date.now();
    const dt = (now - lastHeatUpdate) / 1000;
    lastHeatUpdate = now;
    if (dt > 0) heat *= Math.exp(-dt / HEAT_TAU);
    if (heat < 0.05) heat = 0;
  }

  function registerReaction(listenerId, reactionType) {
    const weight = REACTION_WEIGHTS[reactionType] || 2;
    const now = Date.now();

    reactionTotals[reactionType] = (reactionTotals[reactionType] || 0) + 1;

    // Diminishing returns per listener: rapid same-listener taps lose efficiency
    const hist = (listenerTapHistory.get(listenerId) || []).filter(t => now - t < 2000);
    const efficiency = Math.max(0.3, 1 - 0.08 * hist.length);
    hist.push(now);
    listenerTapHistory.set(listenerId, hist);

    // Sync combo: distinct listeners hitting the same reaction within 3 seconds
    recentReactions = recentReactions.filter(r => now - r.at < 3000);
    recentReactions.push({ listenerId, reactionType, at: now });
    const distinct = new Set(
      recentReactions.filter(r => r.reactionType === reactionType).map(r => r.listenerId)
    );
    let syncMultiplier = 1;
    if (distinct.size >= 2) {
      syncMultiplier = Math.min(2.0, 1 + 0.25 * (distinct.size - 1));
      triggerSyncBadge(syncMultiplier);
    }

    // Heat gain, normalized by audience size so 5 or 500 listeners feel the same scale
    updateHeatDecay();
    const norm = Math.max(1, streamerViewerCount);
    heat = Math.min(100, heat + (weight * efficiency * syncMultiplier * HEAT_GAIN) / norm);

    // Record the moment for the highlight/waveform analysis
    if (isSongPlaying && audioCtx) {
      const elapsed = audioCtx.currentTime - songStartTime;
      momentLog.push({ t: elapsed, type: reactionType, weight: weight * syncMultiplier });
    }
  }

  function triggerSyncBadge(multiplier) {
    const badge = document.getElementById('sync-badge');
    const multEl = document.getElementById('sync-multiplier');
    if (!badge || !multEl) return;

    multEl.innerText = `x${multiplier.toFixed(2)}`;
    badge.classList.add('active');

    // Golden burst around the score core
    if (stageCanvas) {
      for (let i = 0; i < 12; i++) {
        particles.push(new Sparkle(stageCanvas.width / 2, stageCanvas.height * 0.45, '#fbbf24'));
      }
    }

    clearTimeout(syncBadgeTimeout);
    syncBadgeTimeout = setTimeout(() => badge.classList.remove('active'), 1500);
  }

  // --- Result Screen (Streamer Side) ---
  function gradeFor(score) {
    if (score >= 90) return 'S';
    if (score >= 75) return 'A';
    if (score >= 60) return 'B';
    return 'C';
  }

  function computeHighlight() {
    if (momentLog.length === 0) return null;
    const WINDOW = 5; // seconds

    let best = { t: 0, sum: 0, counts: {} };
    for (const m of momentLog) {
      let sum = 0;
      const counts = {};
      for (const n of momentLog) {
        if (n.t >= m.t && n.t < m.t + WINDOW) {
          sum += n.weight;
          counts[n.type] = (counts[n.type] || 0) + 1;
        }
      }
      if (sum > best.sum) best = { t: m.t, sum, counts };
    }

    // Dominant reaction type & total count in the peak window
    let domType = null, domCount = 0, total = 0;
    Object.entries(best.counts).forEach(([type, c]) => {
      total += c;
      if (c > domCount) { domCount = c; domType = type; }
    });

    // Lyric being sung around the peak moment
    let lyric = '';
    for (const item of lyricsData) {
      if (best.t + WINDOW / 2 >= item.time) lyric = item.text;
      else break;
    }

    return { time: best.t, domType, total, lyric };
  }

  function renderWaveform(highlightTime) {
    const canvas = document.getElementById('waveform-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    if (heatCurve.length < 2) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.font = '13px "Noto Sans JP", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('データがありません', W / 2, H / 2);
      return;
    }

    const maxT = heatCurve[heatCurve.length - 1].t || 1;
    const PAD = 8;
    const xFor = t => PAD + (t / maxT) * (W - PAD * 2);
    const yFor = h => H - PAD - (h / 100) * (H - PAD * 2);

    // Filled area under the heat curve
    const gradient = ctx.createLinearGradient(0, 0, 0, H);
    gradient.addColorStop(0, 'rgba(236, 72, 153, 0.45)');
    gradient.addColorStop(1, 'rgba(59, 130, 246, 0.05)');
    ctx.beginPath();
    ctx.moveTo(xFor(heatCurve[0].t), H - PAD);
    heatCurve.forEach(p => ctx.lineTo(xFor(p.t), yFor(p.heat)));
    ctx.lineTo(xFor(maxT), H - PAD);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // Heat curve line
    ctx.beginPath();
    heatCurve.forEach((p, i) => {
      if (i === 0) ctx.moveTo(xFor(p.t), yFor(p.heat));
      else ctx.lineTo(xFor(p.t), yFor(p.heat));
    });
    ctx.strokeStyle = '#ec4899';
    ctx.lineWidth = 2;
    ctx.shadowBlur = 8;
    ctx.shadowColor = '#ec4899';
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Peak moment marker
    if (typeof highlightTime === 'number') {
      const hx = xFor(highlightTime);
      ctx.beginPath();
      ctx.moveTo(hx, PAD);
      ctx.lineTo(hx, H - PAD);
      ctx.strokeStyle = 'rgba(251, 191, 36, 0.8)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#fbbf24';
      ctx.font = '11px "Outfit", sans-serif';
      ctx.textAlign = hx > W - 60 ? 'right' : 'left';
      ctx.fillText('PEAK', hx + (hx > W - 60 ? -5 : 5), PAD + 10);
    }
  }

  function updateRatingSummary() {
    const starsVisual = document.getElementById('result-stars-visual');
    const starsDetail = document.getElementById('result-stars-detail');
    const ratings = [...starRatings.values()];

    let finalScore = lastAvgLiveScore;
    let avgStars = null;
    let breakdown = `ライブ熱量 ${lastAvgLiveScore.toFixed(1)} / 星評価 待ち`;

    if (ratings.length > 0) {
      avgStars = ratings.reduce((a, b) => a + b, 0) / ratings.length;
      finalScore = lastAvgLiveScore * 0.6 + (avgStars * 20) * 0.4;
      const full = Math.round(avgStars);
      starsVisual.innerText = '★'.repeat(full) + '☆'.repeat(5 - full);
      starsDetail.innerText = `${avgStars.toFixed(1)} (${ratings.length}件)`;
      breakdown = `ライブ熱量 ${lastAvgLiveScore.toFixed(1)} ×60% + 星評価 ${(avgStars * 20).toFixed(1)} ×40%`;
    } else {
      starsVisual.innerText = '-';
      starsDetail.innerText = '評価待ち...';
    }

    const grade = gradeFor(finalScore);
    document.getElementById('result-final-score').innerText = finalScore.toFixed(1);
    document.getElementById('result-breakdown').innerText = breakdown;
    document.getElementById('result-grade').innerText = grade;

    // Share the final result with listeners
    if (isConnected && socket) {
      socket.emit('song-event', {
        roomId,
        event: 'final-result',
        payload: { finalScore, grade, avgStars }
      });
    }
  }

  function showResultModal() {
    lastAvgLiveScore = scoreSampleCount > 0 ? scoreSampleSum / scoreSampleCount : 0;

    // Highlight moment
    lastHighlight = computeHighlight();
    const hlContent = document.getElementById('highlight-content');
    if (lastHighlight && lastHighlight.total > 0) {
      const meta = REACTION_META[lastHighlight.domType] || ['🎵', ''];
      hlContent.innerHTML =
        `${lastHighlight.time.toFixed(1)}秒付近 — <span class="hl-lyric">${lastHighlight.lyric || '♪'}</span><br>` +
        `${meta[0]} ${meta[1]} を中心に ${lastHighlight.total} リアクションが集中！`;
    } else {
      hlContent.innerText = 'リアクションはありませんでした';
    }

    // Reaction totals chips
    const totalsEl = document.getElementById('reaction-totals');
    totalsEl.innerHTML = '';
    Object.entries(REACTION_META).forEach(([type, [emoji, label]]) => {
      const chip = document.createElement('div');
      chip.className = 'reaction-total-chip';
      chip.innerHTML = `<span>${emoji}</span><span>${label}</span><span>× ${reactionTotals[type] || 0}</span>`;
      totalsEl.appendChild(chip);
    });

    renderWaveform(lastHighlight ? lastHighlight.time : undefined);
    updateRatingSummary();
    document.getElementById('result-modal').classList.add('active');
  }

  // --- Rendering Loop (Streamer / stage-canvas) ---
  function tickStreamer() {
    stageCtx.clearRect(0, 0, stageCanvas.width, stageCanvas.height);
    
    let elapsed = 0;
    if (isSongPlaying) {
      elapsed = audioCtx.currentTime - songStartTime;
      
      // Stop sequence when finished
      if (elapsed > 48.0) {
        stopSongDemo();
      }
    }

    // Update & Draw Aurora Waves (Centered at Score Ring Core)
    const coreX = stageCanvas.width / 2;
    const coreY = stageCanvas.height * 0.45;
    
    waves.forEach(wave => {
      wave.update(simulatedVolume, currentScore);
      wave.draw(stageCtx, stageCanvas.width, stageCanvas.height, coreY);
    });

    // Score Ring UI updates
    const scoreVal = document.getElementById('score-value');
    if (scoreVal) {
      scoreVal.innerText = currentScore.toFixed(1);
      
      // Update dynamic ring colors and scale based on score
      const ringOuter = document.querySelector('.score-ring-outer');
      const ringInner = document.querySelector('.score-ring-inner');
      const coreContainer = document.querySelector('.score-core-container');
      if (ringOuter) {
        const glowFactor = currentScore / 100;
        ringOuter.style.boxShadow = `0 0 ${20 + glowFactor * 60}px rgba(168, 85, 247, ${0.2 + glowFactor * 0.6})`;

        // Pulse scale on the container (the ring itself is busy with the spin animation)
        if (coreContainer) {
          coreContainer.style.transform = `translate(-50%, -50%) scale(${0.95 + glowFactor * 0.15})`;
        }

        // conic gradient speed & tone shifts (inner counter-spins at the same speed to keep text upright)
        const speed = 10 - (glowFactor * 6);
        ringOuter.style.animationDuration = `${speed}s`;
        if (ringInner) ringInner.style.animationDuration = `${speed}s`;
      }

      // Update feedback label
      const fbLabel = document.getElementById('score-feedback');
      if (fbLabel) {
        if (currentScore > 90) {
          fbLabel.innerText = '神歌声 ✨';
          fbLabel.style.color = 'var(--glow-pink)';
        } else if (currentScore > 75) {
          fbLabel.innerText = '鳥肌! ⚡';
          fbLabel.style.color = 'var(--primary-neon)';
        } else if (currentScore > 50) {
          fbLabel.innerText = 'GOOD 🎵';
          fbLabel.style.color = 'var(--secondary-neon)';
        } else {
          fbLabel.innerText = 'NORMAL';
          fbLabel.style.color = 'var(--text-secondary)';
        }
      }
    }

    // Handle Lyrics scrolling synchronization
    if (isSongPlaying && lyricsData.length > 0) {
      let lyricFound = false;
      for (let i = 0; i < lyricsData.length; i++) {
        const item = lyricsData[i];
        const nextItem = lyricsData[i + 1];
        const isCurrent = elapsed >= item.time && (!nextItem || elapsed < nextItem.time);
        
        if (isCurrent) {
          if (currentLyricIndex !== i) {
            currentLyricIndex = i;
            // Update UI
            document.getElementById('current-lyric').innerText = item.text;
            
            // Trigger flash animation on lyric container
            const lyricBox = document.querySelector('.lyrics-display');
            lyricBox.style.transform = 'scale(1.05)';
            setTimeout(() => lyricBox.style.transform = 'scale(1.0)', 150);
          }
          lyricFound = true;
          break;
        }
      }

      // Scroll Pitch guide notes horizontally
      const notesContainer = document.getElementById('pitch-guide-notes');
      if (notesContainer) {
        // We want the playhead (fixed at 150px) to represent the current time elapsed
        // Each second is 35px. Thus offset = 150px - (elapsed * 35)
        const offset = 150 - (elapsed * 35);
        notesContainer.style.transform = `translateX(${offset}px)`;
        
        // Highlight passed notes
        const blocks = notesContainer.querySelectorAll('.pitch-note-block');
        blocks.forEach(block => {
          const bTime = parseFloat(block.getAttribute('data-time'));
          if (elapsed > bTime) {
            block.classList.add('passed');
          } else {
            block.classList.remove('passed');
          }
        });
      }
    }

    // Update Score Contribution Engine
    calculateStreamerScore(elapsed);

    // Update and Draw Particles
    particles = particles.filter(p => {
      const active = p.update();
      if (active) {
        p.draw(stageCtx);
      } else if (p.life <= 0 && p.targetX !== null) {
        // Trigger small sparkle burst on core arrival
        for (let i = 0; i < 8; i++) {
          particles.push(new Sparkle(coreX, coreY, p.color));
        }
      }
      return active || p.life > 0;
    });

    animationFrameId = requestAnimationFrame(tickStreamer);
  }

  // --- Particles & Rendering Loop (Listener/スマホ側) ---
  function createLocalListenerParticles(x, y, type) {
    // Generate immediate feedback sparkles on local screen
    let color;
    switch(type) {
      case 'tear': color = '#60a5fa'; break;
      case 'goosebumps': color = '#fbbf24'; break;
      case 'god': color = '#a855f7'; break;
      case 'popopo': color = '#ec4899'; break;
      default: color = '#ffffff';
    }
    
    // Blast 12 beautiful fast exploding particles from tap point
    for (let i = 0; i < 15; i++) {
      const p = new Sparkle(x, y, color);
      // Give them high explosive speed
      p.vx = (Math.random() - 0.5) * 12;
      p.vy = (Math.random() - 0.5) * 12 - 3;
      listenerParticles.push(p);
    }
  }

  function tickListener() {
    listenerCtx.clearRect(0, 0, listenerCanvas.width, listenerCanvas.height);

    // Reset the rapid-tap combo when tapping pauses
    if (comboCount > 0 && Date.now() - lastTapAt > 1500) {
      comboCount = 0;
      updateComboIndicator();
    }

    // Update and Draw local listener particles
    listenerParticles = listenerParticles.filter(p => {
      const active = p.update();
      if (active) {
        p.draw(listenerCtx);
      }
      return active;
    });

    requestAnimationFrame(tickListener);
  }
});
