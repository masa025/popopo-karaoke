// Application Logic for POPOPO SparkleScore Live
// Companion scoring app: singing & listening happen in the POPOPO app.
// This app turns listener reactions into a live heat score + final results.

document.addEventListener('DOMContentLoaded', () => {
  // Global Variables & Config
  let socket;
  let currentRole = null; // 'streamer' or 'listener'
  let roomId = null;
  let isConnected = false;

  // Streamer Side Variables
  let songTitle = '';
  let singerName = '';
  let sessionStartTime = 0; // Date.now() when the song starts
  let isSongPlaying = false;
  let currentScore = 0;
  let targetScore = 0;
  let streamerViewerCount = 0;

  // --- Reaction Heat Engine (Streamer Side) ---
  const REACTION_WEIGHTS = { tear: 3, goosebumps: 4, god: 5, popopo: 2 };
  const REACTION_META = {
    tear: ['😭', '泣ける'],
    goosebumps: ['⚡', '鳥肌'],
    god: ['✨', '神歌声'],
    popopo: ['🎉', 'POPOPO!'],
    donmai: ['😅', 'ドンマイ']
  };
  const DONMAI_MAX_PER_SONG = 3;
  const HEAT_TAU = 8;    // Exponential decay time constant (seconds) => half-life ~5.5s
  const HEAT_GAIN = 1.7; // Points-per-tap scaling factor
  let heat = 0;
  let lastHeatUpdate = Date.now();
  let recentReactions = [];
  let listenerTapHistory = new Map();
  let momentLog = [];
  let heatCurve = [];
  let lastCurveSample = -1;
  let scoreSampleSum = 0;
  let scoreSampleCount = 0;
  let lastAvgLiveScore = 0;
  let starRatings = new Map();
  let reactionTotals = { tear: 0, goosebumps: 0, god: 0, popopo: 0 };
  let lastHighlight = null;
  let syncBadgeTimeout = null;
  let donmaiEnabled = false;          // Streamer opt-in
  let donmaiTotal = 0;                // Total donmai count for the song
  let donmaiPerListener = new Map();  // listenerId -> count (max 3 per song)
  let donmaiMoments = [];             // Timestamped donmai (for the result waveform)

  // Particles System
  let stageCanvas, stageCtx;
  let particles = [];
  let waves = [];

  // Listener Side Variables
  let listenerCanvas, listenerCtx;
  let listenerParticles = [];
  let floatingEmojis = [];
  const MAX_FLOATING_EMOJIS = 40;
  let tapCounts = {};
  let tapTimestamps = [];
  let comboCount = 0;
  let lastTapAt = 0;
  let hasRatedThisSong = false;
  let donmaiRemaining = DONMAI_MAX_PER_SONG;

  // --- Visual Classes ---
  class Wave {
    constructor(color, speed, amplitude, frequency, offset) {
      this.color = color;
      this.speed = speed;
      this.amplitude = amplitude;
      this.frequency = frequency;
      this.offset = offset;
      this.phase = Math.random() * 100;
    }
    update(energy, emotion) {
      this.phase += this.speed * (0.5 + energy * 0.01);
      this.currentAmp = this.amplitude * (0.3 + (energy * 0.007)) * (0.8 + emotion * 0.005);
    }
    draw(ctx, width, height, coreY) {
      ctx.beginPath();
      ctx.strokeStyle = this.color;
      ctx.lineWidth = 2.5;
      ctx.shadowBlur = 15;
      ctx.shadowColor = this.color;

      for (let x = 0; x < width; x += 5) {
        const angle = (x / width) * Math.PI * 2 * this.frequency + this.phase + this.offset;
        const y = coreY + Math.sin(angle) * this.currentAmp;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  }

  class Particle {
    constructor(x, y, targetX, targetY, type, scale = 1) {
      this.x = x;
      this.y = y;
      this.targetX = targetX;
      this.targetY = targetY;
      this.type = type;
      this.scale = scale;

      const angle = Math.atan2(targetY - y, targetX - x);
      const dist = Math.hypot(targetX - x, targetY - y);
      const speedFactor = 0.02 + Math.random() * 0.025;

      this.vx = Math.cos(angle) * dist * speedFactor + (Math.random() - 0.5) * 4;
      this.vy = Math.sin(angle) * dist * speedFactor + (Math.random() - 0.5) * 4;

      this.life = 1.0;
      this.decay = 0.015 + Math.random() * 0.015;
      this.size = (3 + Math.random() * 6) * scale;

      switch (type) {
        case 'tear':
          this.colors = ['#60a5fa', '#3b82f6', '#1d4ed8'];
          break;
        case 'goosebumps':
          this.colors = ['#fbbf24', '#f59e0b', '#d97706'];
          break;
        case 'god':
          this.colors = ['#c084fc', '#a855f7', '#7e22ce'];
          break;
        case 'popopo':
          this.colors = ['#f472b6', '#ec4899', '#be185d'];
          break;
        case 'donmai': // Soft sweat-drop blues
          this.colors = ['#7dd3fc', '#bae6fd', '#e0f2fe'];
          break;
        default:
          this.colors = ['#ffffff', '#f3f4f6'];
      }
      this.color = this.colors[Math.floor(Math.random() * this.colors.length)];
    }

    update() {
      if (this.targetX !== null) {
        const dx = this.targetX - this.x;
        const dy = this.targetY - this.y;
        const dist = Math.hypot(dx, dy);

        if (dist > 15) {
          this.vx += (dx / dist) * 0.4;
          this.vy += (dy / dist) * 0.4;
          this.vx *= 0.95;
          this.vy *= 0.95;
        } else {
          this.life = 0;
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
      ctx.shadowBlur = 10;
      ctx.shadowColor = this.color;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  // Floating emoji for reactions from OTHER listeners (rises from the bottom, TikTok-heart style)
  class FloatingEmoji {
    constructor(emoji, canvasWidth, canvasHeight) {
      this.emoji = emoji;
      this.x = 30 + Math.random() * (canvasWidth - 60);
      this.y = canvasHeight + 30;
      this.vy = 1.6 + Math.random() * 1.4;
      this.swayAmp = 15 + Math.random() * 25;
      this.swaySpeed = 0.02 + Math.random() * 0.03;
      this.phase = Math.random() * Math.PI * 2;
      this.size = 22 + Math.random() * 14;
      this.life = 1.0;
      this.decay = 0.004 + Math.random() * 0.003;
      this.baseX = this.x;
    }
    update() {
      this.y -= this.vy;
      this.phase += this.swaySpeed;
      this.x = this.baseX + Math.sin(this.phase) * this.swayAmp;
      this.life -= this.decay;
      return this.life > 0 && this.y > -40;
    }
    draw(ctx) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, this.life * 1.5);
      ctx.font = `${this.size}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(this.emoji, this.x, this.y);
      ctx.restore();
    }
  }

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
      this.targetX = null;
    }
    update() {
      this.x += this.vx;
      this.y += this.vy;
      this.vy += 0.1;
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

  // --- UI Elements ---
  const selectionScreen = document.getElementById('selection-screen');
  const streamerScreen = document.getElementById('streamer-screen');
  const listenerScreen = document.getElementById('listener-screen');
  const selectionButtons = document.getElementById('selection-buttons');
  const streamerSetup = document.getElementById('streamer-setup');
  const listenerRoomInput = document.getElementById('listener-room-input');
  const joinError = document.getElementById('join-error');

  const qrModal = document.getElementById('qr-modal');
  const shareUrlInput = document.getElementById('share-url-input');
  const qrcodeContainer = document.getElementById('qrcode-container');
  let qrcodeObj = null;

  // --- Router / Param Parsing ---
  const urlParams = new URLSearchParams(window.location.search);
  const paramRole = urlParams.get('role');
  const paramRoom = urlParams.get('room');
  const paramSong = urlParams.get('song');
  const paramSinger = urlParams.get('singer');

  if (paramRoom) roomId = paramRoom.toUpperCase();
  if (paramSong) songTitle = decodeURIComponent(paramSong);
  if (paramSinger) singerName = decodeURIComponent(paramSinger);
  if (urlParams.get('donmai') === '1') donmaiEnabled = true;

  if (paramRole === 'streamer' && roomId) {
    startStreamerRole();
  } else if (paramRole === 'listener' && roomId) {
    startListenerRole();
  }

  // --- Sparkle Score Info Modal (available on every screen) ---
  document.querySelectorAll('.btn-score-info').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('score-info-modal').classList.add('active');
    });
  });
  document.getElementById('btn-close-score-info').addEventListener('click', () => {
    document.getElementById('score-info-modal').classList.remove('active');
  });
  document.getElementById('score-info-modal').addEventListener('click', (e) => {
    if (e.target.id === 'score-info-modal') {
      e.target.classList.remove('active'); // Tap outside the card to close
    }
  });

  // --- Selection Screen Interaction ---
  document.getElementById('btn-select-streamer').addEventListener('click', () => {
    selectionButtons.style.display = 'none';
    streamerSetup.style.display = 'flex';
    hideJoinError();
  });

  document.getElementById('btn-select-listener').addEventListener('click', () => {
    selectionButtons.style.display = 'none';
    listenerRoomInput.style.display = 'flex';
    hideJoinError();
  });

  document.getElementById('btn-back-selection').addEventListener('click', backToSelection);
  document.getElementById('btn-back-selection-streamer').addEventListener('click', backToSelection);

  function backToSelection() {
    selectionButtons.style.display = 'flex';
    streamerSetup.style.display = 'none';
    listenerRoomInput.style.display = 'none';
    hideJoinError();
  }

  document.getElementById('btn-create-room').addEventListener('click', () => {
    songTitle = document.getElementById('input-song-title').value.trim() || 'アカペラライブ';
    singerName = document.getElementById('input-singer-name').value.trim();
    donmaiEnabled = document.getElementById('input-donmai-enabled').checked;
    hideJoinError();
    startStreamerRole();
  });

  document.getElementById('btn-join-room').addEventListener('click', () => {
    const inputId = document.getElementById('input-room-id').value.trim().toUpperCase();
    if (!inputId) {
      showJoinError('ルームコードを入力してください。');
      return;
    }
    roomId = inputId;
    hideJoinError();
    startListenerRole();
  });

  function showJoinError(msg) {
    joinError.innerText = msg;
    joinError.style.display = 'block';
  }

  function hideJoinError() {
    joinError.style.display = 'none';
  }

  // --- Streamer Role ---
  function startStreamerRole() {
    currentRole = 'streamer';
    selectionScreen.classList.remove('active');
    streamerScreen.classList.add('active');

    // Canvas & visuals
    stageCanvas = document.getElementById('stage-canvas');
    stageCtx = stageCanvas.getContext('2d');
    resizeStageCanvas();
    window.addEventListener('resize', resizeStageCanvas);

    waves = [
      new Wave('rgba(168, 85, 247, 0.4)', 0.02, 60, 1.5, 0),
      new Wave('rgba(59, 130, 246, 0.35)', 0.015, 80, 2.2, Math.PI / 4),
      new Wave('rgba(236, 72, 153, 0.3)', 0.025, 40, 3.0, Math.PI / 2)
    ];

    updateStreamerSongUI();

    // Song controls
    document.getElementById('btn-start-song').addEventListener('click', startSong);
    document.getElementById('btn-end-song').addEventListener('click', endSong);

    // QR / share
    document.getElementById('btn-toggle-qr').addEventListener('click', showInviteModal);
    document.getElementById('btn-close-qr').addEventListener('click', hideInviteModal);
    document.getElementById('btn-copy-url').addEventListener('click', copyShareURL);

    // Result modal close
    document.getElementById('btn-close-result').addEventListener('click', () => {
      document.getElementById('result-modal').classList.remove('active');
    });

    initSocketConnection();
    tickStreamer();
  }

  function updateStreamerSongUI() {
    const title = singerName ? `${songTitle} - ${singerName}` : songTitle;
    document.getElementById('streamer-song-title').innerText = title || '-';
    document.getElementById('streamer-room-code').innerText = roomId || '----';
    document.getElementById('qr-room-code').innerText = roomId || '----';
  }

  function updateStreamerURL() {
    const params = new URLSearchParams({
      role: 'streamer',
      room: roomId,
      song: songTitle,
      singer: singerName,
      donmai: donmaiEnabled ? '1' : '0'
    });
    window.history.replaceState({}, '', `?${params.toString()}`);
  }

  function resizeStageCanvas() {
    stageCanvas.width = stageCanvas.parentElement.clientWidth;
    stageCanvas.height = stageCanvas.parentElement.clientHeight;
  }

  function listenerShareURL() {
    return `${window.location.origin}/?role=listener&room=${roomId}`;
  }

  function showInviteModal() {
    if (!roomId) return;
    const shareURL = listenerShareURL();
    shareUrlInput.value = shareURL;
    qrModal.classList.add('active');

    if (!qrcodeObj) {
      qrcodeObj = new QRCode(qrcodeContainer, {
        text: shareURL,
        width: 180,
        height: 180,
        colorDark: '#070913',
        colorLight: '#ffffff',
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
    const copyBtn = document.getElementById('btn-copy-url');
    const done = () => {
      copyBtn.innerText = 'コピー済';
      setTimeout(() => { copyBtn.innerText = 'コピー'; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(shareUrlInput.value).then(done).catch(() => {
        shareUrlInput.select();
        document.execCommand('copy');
        done();
      });
    } else {
      shareUrlInput.select();
      document.execCommand('copy');
      done();
    }
  }

  // --- Song Lifecycle (Streamer) ---
  function startSong() {
    if (isSongPlaying) return;
    isSongPlaying = true;
    sessionStartTime = Date.now();

    // Reset the scoring engine
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
    donmaiTotal = 0;
    donmaiPerListener.clear();
    donmaiMoments = [];
    document.getElementById('result-modal').classList.remove('active');

    // UI state
    document.getElementById('btn-start-song').disabled = true;
    document.getElementById('btn-end-song').disabled = false;
    const stateLabel = document.getElementById('live-state-label');
    stateLabel.innerText = 'LIVE';
    stateLabel.classList.remove('waiting');
    stateLabel.classList.add('live');
    document.getElementById('streamer-live-text').innerText = 'LIVE';

    if (isConnected && socket) {
      socket.emit('song-event', { roomId, event: 'song-start' });
    }
  }

  function endSong() {
    if (!isSongPlaying) return;
    isSongPlaying = false;

    // UI state
    document.getElementById('btn-start-song').disabled = false;
    document.getElementById('btn-end-song').disabled = true;
    const stateLabel = document.getElementById('live-state-label');
    stateLabel.innerText = '待機中';
    stateLabel.classList.remove('live');
    stateLabel.classList.add('waiting');
    document.getElementById('streamer-live-text').innerText = 'READY';

    if (isConnected && socket) {
      socket.emit('song-event', { roomId, event: 'song-end' });
    }
    showResultModal();
  }

  // --- Listener Role ---
  function startListenerRole() {
    currentRole = 'listener';
    selectionScreen.classList.remove('active');
    listenerScreen.classList.add('active');

    listenerCanvas = document.getElementById('listener-particle-canvas');
    listenerCtx = listenerCanvas.getContext('2d');
    resizeListenerCanvas();
    window.addEventListener('resize', resizeListenerCanvas);

    // Reaction buttons (rapid-tap friendly)
    document.querySelectorAll('.reaction-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const now = Date.now();

        // Local rate limit: max 8 taps/sec across all buttons
        tapTimestamps = tapTimestamps.filter(t => now - t < 1000);
        if (tapTimestamps.length >= 8) return;
        tapTimestamps.push(now);

        const rect = btn.getBoundingClientRect();
        const reactionType = btn.getAttribute('data-reaction');

        tapCounts[reactionType] = (tapCounts[reactionType] || 0) + 1;
        const countEl = document.getElementById(`count-${reactionType}`);
        if (countEl) countEl.innerText = tapCounts[reactionType];

        btn.classList.remove('tapped');
        void btn.offsetWidth;
        btn.classList.add('tapped');

        comboCount = (now - lastTapAt < 900) ? comboCount + 1 : 1;
        lastTapAt = now;
        updateComboIndicator();

        createLocalListenerParticles(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
          reactionType
        );
        // Own reactions also float up, matching what everyone else sees
        spawnFloatingEmoji(reactionType);

        sendReaction(reactionType);
      });
    });

    // Donmai button (affectionate "nice try" — never affects the score)
    document.getElementById('btn-donmai').addEventListener('click', () => {
      if (donmaiRemaining <= 0) return;
      donmaiRemaining--;
      updateDonmaiUI();

      const btn = document.getElementById('btn-donmai');
      const rect = btn.getBoundingClientRect();
      createLocalListenerParticles(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
        'donmai'
      );
      spawnFloatingEmoji('donmai');
      sendReaction('donmai');
    });

    // Star Rating buttons
    document.querySelectorAll('.star-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (hasRatedThisSong) return;
        const stars = parseInt(btn.getAttribute('data-stars'));

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

    document.getElementById('btn-close-listener-result').addEventListener('click', () => {
      document.getElementById('listener-result-overlay').classList.remove('active');
    });

    initSocketConnection();
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

  function updateListenerRoomUI(room) {
    document.getElementById('listener-song-title').innerText = room.songTitle || '-';
    document.getElementById('listener-singer-name').innerText = room.singerName || 'POPOPO Live Session';
    setListenerLiveBadge(room.isLive);

    donmaiEnabled = !!room.donmaiEnabled;
    document.getElementById('donmai-container').style.display = donmaiEnabled ? 'flex' : 'none';
    updateDonmaiUI();
  }

  function updateDonmaiUI() {
    const btn = document.getElementById('btn-donmai');
    const remainEl = document.getElementById('donmai-remaining');
    if (!btn || !remainEl) return;
    remainEl.innerText = donmaiRemaining > 0 ? `残り${donmaiRemaining}回` : '本日終了';
    btn.disabled = donmaiRemaining <= 0;
  }

  function setListenerLiveBadge(isLive) {
    const badge = document.getElementById('listener-live-badge');
    if (!badge) return;
    badge.innerText = isLive ? 'LIVE' : '待機中';
    badge.classList.toggle('live', isLive);
    badge.classList.toggle('waiting', !isLive);
  }

  function updateListenerScoreHero(score) {
    const numEl = document.getElementById('listener-score-val');
    const fbEl = document.getElementById('listener-score-feedback');
    if (!numEl) return;

    numEl.innerText = score.toFixed(1);
    const glowFactor = Math.max(0, Math.min(1, score / 100));

    let text, color;
    if (score > 85) { text = '神歌声 ✨'; color = 'var(--glow-pink)'; }
    else if (score > 65) { text = '鳥肌! ⚡'; color = 'var(--primary-neon)'; }
    else if (score > 40) { text = 'GOOD 🎵'; color = 'var(--secondary-neon)'; }
    else { text = 'STANDBY'; color = 'var(--text-secondary)'; }

    numEl.style.textShadow = `0 0 ${8 + glowFactor * 24}px rgba(168, 85, 247, ${0.3 + glowFactor * 0.7})`;
    if (fbEl) {
      fbEl.innerText = text;
      fbEl.style.color = color;
    }
  }

  function spawnFloatingEmoji(reactionType) {
    if (!listenerCanvas) return;
    if (floatingEmojis.length >= MAX_FLOATING_EMOJIS) return; // Avoid flooding on big rooms
    const meta = REACTION_META[reactionType];
    if (!meta) return;
    floatingEmojis.push(new FloatingEmoji(meta[0], listenerCanvas.width, listenerCanvas.height));
  }

  function showListenerNotice(msg) {
    const el = document.getElementById('listener-notice');
    el.innerText = msg;
    el.style.display = 'block';
  }

  function hideListenerNotice() {
    document.getElementById('listener-notice').style.display = 'none';
  }

  // --- WebSocket Connection ---
  function initSocketConnection() {
    try {
      socket = io();

      socket.on('connect', () => {
        isConnected = true;

        if (currentRole === 'streamer') {
          if (roomId) {
            // Re-join existing room (reload / reconnect / server restart)
            socket.emit('join-room', { roomId, role: 'streamer', songTitle, singerName, donmaiEnabled }, (res) => {
              if (res && res.ok) updateStreamerSongUI();
            });
          } else {
            // Create a brand-new room
            socket.emit('create-room', { songTitle, singerName, donmaiEnabled }, (res) => {
              if (res && res.ok) {
                roomId = res.roomId;
                updateStreamerSongUI();
                updateStreamerURL();
              }
            });
          }
        } else if (currentRole === 'listener') {
          socket.emit('join-room', { roomId, role: 'listener' }, (res) => {
            if (!res || !res.ok) {
              // Back to selection screen with the error shown
              listenerScreen.classList.remove('active');
              selectionScreen.classList.add('active');
              selectionButtons.style.display = 'none';
              listenerRoomInput.style.display = 'flex';
              document.getElementById('input-room-id').value = roomId || '';
              showJoinError((res && res.error) || '入室に失敗しました。');
              window.history.replaceState({}, '', window.location.pathname);
              roomId = null;
              return;
            }
            hideListenerNotice();
            updateListenerRoomUI(res.room);
          });
        }
      });

      // Streamer Listeners
      if (currentRole === 'streamer') {
        socket.on('room-status', ({ listenersCount }) => {
          streamerViewerCount = listenersCount;
          document.getElementById('streamer-viewer-count').innerText = streamerViewerCount;
        });

        socket.on('listener-reaction', ({ listenerId, reactionType }) => {
          registerReaction(listenerId, reactionType);

          const startX = Math.random() * stageCanvas.width;
          const startY = stageCanvas.height + 20;
          const targetX = stageCanvas.width / 2;
          const targetY = stageCanvas.height * 0.45;

          particles.push(new Particle(startX, startY, targetX, targetY, reactionType, 1.5));
        });

        socket.on('final-rating', ({ listenerId, stars }) => {
          starRatings.set(listenerId, stars);
          updateRatingSummary();
        });
      }

      // Listener Listeners
      if (currentRole === 'listener') {
        socket.on('room-status', ({ streamerOnline }) => {
          if (streamerOnline === false) {
            showListenerNotice('歌い手の接続が切れました。復帰を待っています...');
          } else {
            hideListenerNotice();
          }
        });

        socket.on('global-score-sync', ({ score, heat: globalHeat }) => {
          updateListenerScoreHero(score || 0);
          const h = Math.max(0, Math.min(100, globalHeat || 0));
          document.getElementById('heat-value').innerText = Math.round(h);
          document.getElementById('heat-bar-fill').style.width = `${h}%`;
        });

        // Reactions from OTHER listeners float up across the screen
        socket.on('listener-reaction', ({ reactionType }) => {
          spawnFloatingEmoji(reactionType);
        });

        socket.on('song-event', ({ event, payload }) => {
          if (event === 'song-start') {
            hasRatedThisSong = false;
            tapCounts = {};
            donmaiRemaining = DONMAI_MAX_PER_SONG;
            updateDonmaiUI();
            Object.keys(REACTION_META).forEach(t => {
              const el = document.getElementById(`count-${t}`);
              if (el) el.innerText = '0';
            });
            document.querySelectorAll('.star-btn').forEach(b => b.classList.remove('lit'));
            document.getElementById('rating-thanks').style.display = 'none';
            document.getElementById('rating-overlay').classList.remove('active');
            document.getElementById('listener-result-overlay').classList.remove('active');
            setListenerLiveBadge(true);
          } else if (event === 'song-end') {
            setListenerLiveBadge(false);
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
            if (hasRatedThisSong) {
              document.getElementById('listener-result-overlay').classList.add('active');
            }
          }
        });
      }

      socket.on('disconnect', () => {
        isConnected = false;
        if (currentRole === 'listener') {
          showListenerNotice('サーバーとの接続が切れました。再接続しています...');
        }
      });

    } catch (e) {
      console.warn('Socket.io failed to initialize.', e);
    }
  }

  function sendReaction(type) {
    if (isConnected && socket && roomId) {
      socket.emit('reaction-send', { roomId, reactionType: type });
    }
  }

  // --- Score Engine (Streamer Side) ---
  function calculateStreamerScore() {
    updateHeatDecay();

    // The audience heat IS the live score
    targetScore = Math.max(0, Math.min(100, heat));
    currentScore += (targetScore - currentScore) * 0.08;

    // Sample curves & running average while the song is playing
    if (isSongPlaying) {
      const elapsedSeconds = (Date.now() - sessionStartTime) / 1000;
      scoreSampleSum += currentScore;
      scoreSampleCount++;
      if (elapsedSeconds - lastCurveSample >= 0.5) {
        lastCurveSample = elapsedSeconds;
        heatCurve.push({ t: elapsedSeconds, heat, score: currentScore });
      }
    }

    // Emit global score + heat to listeners (throttled)
    if (isConnected && socket && roomId && Math.random() < 0.15) {
      socket.emit('score-sync-relay', { roomId, score: currentScore, heat });
    }
  }

  function updateHeatDecay() {
    const now = Date.now();
    const dt = (now - lastHeatUpdate) / 1000;
    lastHeatUpdate = now;
    if (dt > 0) heat *= Math.exp(-dt / HEAT_TAU);
    if (heat < 0.05) heat = 0;
  }

  function registerReaction(listenerId, reactionType) {
    // Donmai: counted separately, hard-capped per listener, and NEVER touches the score
    if (reactionType === 'donmai') {
      const used = donmaiPerListener.get(listenerId) || 0;
      if (used >= DONMAI_MAX_PER_SONG) return;
      donmaiPerListener.set(listenerId, used + 1);
      donmaiTotal++;
      if (isSongPlaying) {
        donmaiMoments.push({ t: (Date.now() - sessionStartTime) / 1000 });
      }
      return;
    }

    const weight = REACTION_WEIGHTS[reactionType] || 2;
    const now = Date.now();

    reactionTotals[reactionType] = (reactionTotals[reactionType] || 0) + 1;

    // Diminishing returns per listener
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

    // Heat gain, normalized by audience size
    updateHeatDecay();
    const norm = Math.max(1, streamerViewerCount);
    heat = Math.min(100, heat + (weight * efficiency * syncMultiplier * HEAT_GAIN) / norm);

    // Record the moment for highlight analysis
    if (isSongPlaying) {
      const elapsed = (Date.now() - sessionStartTime) / 1000;
      momentLog.push({ t: elapsed, type: reactionType, weight: weight * syncMultiplier });
    }
  }

  function triggerSyncBadge(multiplier) {
    const badge = document.getElementById('sync-badge');
    const multEl = document.getElementById('sync-multiplier');
    if (!badge || !multEl) return;

    multEl.innerText = `x${multiplier.toFixed(2)}`;
    badge.classList.add('active');

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
    if (score >= 85) return 'S';
    if (score >= 70) return 'A';
    if (score >= 50) return 'B';
    return 'C';
  }

  function fmtTime(totalSeconds) {
    const m = Math.floor(totalSeconds / 60);
    const s = Math.floor(totalSeconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function computeHighlight() {
    if (momentLog.length === 0) return null;
    const WINDOW = 5;

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

    let domType = null, domCount = 0, total = 0;
    Object.entries(best.counts).forEach(([type, c]) => {
      total += c;
      if (c > domCount) { domCount = c; domType = type; }
    });

    return { time: best.t, domType, total };
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
    const PADX = 10;   // Horizontal padding
    const PADT = 18;   // Top padding (donmai lane)
    const PADB = 24;   // Bottom padding (time axis labels)
    const baseY = H - PADB;
    const xFor = t => PADX + (t / maxT) * (W - PADX * 2);
    const yFor = h => baseY - (h / 100) * (baseY - PADT);

    // Interpolated heat value at an arbitrary time
    const heatAt = (t) => {
      let lo = heatCurve[0];
      let hi = heatCurve[heatCurve.length - 1];
      for (let i = 0; i < heatCurve.length; i++) {
        if (heatCurve[i].t >= t) {
          hi = heatCurve[i];
          lo = heatCurve[Math.max(0, i - 1)];
          break;
        }
      }
      if (hi.t === lo.t) return lo.heat;
      const f = Math.max(0, Math.min(1, (t - lo.t) / (hi.t - lo.t)));
      return lo.heat + (hi.heat - lo.heat) * f;
    };

    // --- Time axis (mm:ss ticks) ---
    let tickStep;
    if (maxT <= 45) tickStep = 10;
    else if (maxT <= 120) tickStep = 30;
    else if (maxT <= 360) tickStep = 60;
    else tickStep = 120;

    ctx.font = '10px "Outfit", sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 1;
    for (let t = 0; t <= maxT; t += tickStep) {
      const x = xFor(t);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
      ctx.beginPath();
      ctx.moveTo(x, PADT);
      ctx.lineTo(x, baseY);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.fillText(fmtTime(t), x, H - 8);
    }
    // Baseline
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.beginPath();
    ctx.moveTo(PADX, baseY);
    ctx.lineTo(W - PADX, baseY);
    ctx.stroke();

    // --- Heat area fill + curve ---
    const gradient = ctx.createLinearGradient(0, 0, 0, H);
    gradient.addColorStop(0, 'rgba(236, 72, 153, 0.45)');
    gradient.addColorStop(1, 'rgba(59, 130, 246, 0.05)');
    ctx.beginPath();
    ctx.moveTo(xFor(heatCurve[0].t), baseY);
    heatCurve.forEach(p => ctx.lineTo(xFor(p.t), yFor(p.heat)));
    ctx.lineTo(xFor(maxT), baseY);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

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

    // --- Reaction markers (1-second bins, dominant emoji above the curve) ---
    if (momentLog.length > 0) {
      const bins = new Map();
      momentLog.forEach(m => {
        const sec = Math.floor(m.t);
        if (!bins.has(sec)) bins.set(sec, {});
        const b = bins.get(sec);
        b[m.type] = (b[m.type] || 0) + 1;
      });
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      bins.forEach((counts, sec) => {
        let domType = null, domCount = 0;
        Object.entries(counts).forEach(([type, c]) => {
          if (c > domCount) { domCount = c; domType = type; }
        });
        const meta = REACTION_META[domType];
        if (!meta) return;
        const t = Math.min(sec + 0.5, maxT);
        const x = xFor(t);
        const y = Math.max(PADT + 12, yFor(heatAt(t)) - 8);
        ctx.fillText(meta[0], x, y);
      });
    }

    // --- Donmai markers (top lane with drop lines) ---
    if (donmaiMoments.length > 0) {
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      donmaiMoments.forEach(dm => {
        const x = xFor(Math.min(dm.t, maxT));
        ctx.strokeStyle = 'rgba(125, 211, 252, 0.4)';
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(x, PADT + 4);
        ctx.lineTo(x, baseY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillText('😅', x, PADT);
      });
    }

    // --- PEAK marker ---
    if (typeof highlightTime === 'number') {
      const hx = xFor(highlightTime);
      ctx.beginPath();
      ctx.moveTo(hx, PADT);
      ctx.lineTo(hx, baseY);
      ctx.strokeStyle = 'rgba(251, 191, 36, 0.8)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#fbbf24';
      ctx.font = '11px "Outfit", sans-serif';
      ctx.textAlign = hx > W - 60 ? 'right' : 'left';
      ctx.fillText('PEAK', hx + (hx > W - 60 ? -5 : 5), PADT + 12);
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

    if (isConnected && socket && roomId) {
      socket.emit('song-event', {
        roomId,
        event: 'final-result',
        payload: { finalScore, grade, avgStars }
      });
    }
  }

  function showResultModal() {
    lastAvgLiveScore = scoreSampleCount > 0 ? scoreSampleSum / scoreSampleCount : 0;

    lastHighlight = computeHighlight();
    const hlContent = document.getElementById('highlight-content');
    if (lastHighlight && lastHighlight.total > 0) {
      const meta = REACTION_META[lastHighlight.domType] || ['🎵', ''];
      hlContent.innerHTML =
        `開始から <span class="hl-lyric">${fmtTime(lastHighlight.time)}</span> 頃 — ` +
        `${meta[0]} ${meta[1]} を中心に ${lastHighlight.total} リアクションが集中！`;
    } else {
      hlContent.innerText = 'リアクションはありませんでした';
    }

    const totalsEl = document.getElementById('reaction-totals');
    totalsEl.innerHTML = '';
    Object.entries(REACTION_META).forEach(([type, [emoji, label]]) => {
      if (type === 'donmai') return; // Shown separately below (never part of the score)
      const chip = document.createElement('div');
      chip.className = 'reaction-total-chip';
      chip.innerHTML = `<span>${emoji}</span><span>${label}</span><span>× ${reactionTotals[type] || 0}</span>`;
      totalsEl.appendChild(chip);
    });
    if (donmaiEnabled || donmaiTotal > 0) {
      const chip = document.createElement('div');
      chip.className = 'reaction-total-chip donmai-chip';
      chip.innerHTML = `<span>😅</span><span>ドンマイ</span><span>× ${donmaiTotal}</span><span class="donmai-chip-note">ご愛嬌・スコア影響なし</span>`;
      totalsEl.appendChild(chip);
    }

    // Donmai time list (practice feedback: exactly when the "nice try" moments happened)
    const donmaiTimesEl = document.getElementById('donmai-times');
    if (donmaiMoments.length > 0) {
      const shown = donmaiMoments.slice(0, 10).map(dm => fmtTime(dm.t)).join(', ');
      const more = donmaiMoments.length > 10 ? ` ほか${donmaiMoments.length - 10}件` : '';
      donmaiTimesEl.innerText = `😅 ドンマイ位置: ${shown}${more}`;
      donmaiTimesEl.style.display = 'block';
    } else {
      donmaiTimesEl.style.display = 'none';
    }

    renderWaveform(lastHighlight ? lastHighlight.time : undefined);
    updateRatingSummary();
    document.getElementById('result-modal').classList.add('active');
  }

  // --- Rendering Loop (Streamer) ---
  function tickStreamer() {
    stageCtx.clearRect(0, 0, stageCanvas.width, stageCanvas.height);

    const coreY = stageCanvas.height * 0.45;
    const coreX = stageCanvas.width / 2;

    // Waves are driven by the audience heat
    const energy = 30 + heat * 0.7;
    waves.forEach(wave => {
      wave.update(energy, currentScore);
      wave.draw(stageCtx, stageCanvas.width, stageCanvas.height, coreY);
    });

    // Score Ring UI
    const scoreVal = document.getElementById('score-value');
    if (scoreVal) {
      scoreVal.innerText = currentScore.toFixed(1);

      const ringOuter = document.querySelector('.score-ring-outer');
      const ringInner = document.querySelector('.score-ring-inner');
      const coreContainer = document.querySelector('.score-core-container');
      if (ringOuter) {
        const glowFactor = currentScore / 100;
        ringOuter.style.boxShadow = `0 0 ${20 + glowFactor * 60}px rgba(168, 85, 247, ${0.2 + glowFactor * 0.6})`;

        if (coreContainer) {
          coreContainer.style.transform = `translate(-50%, -50%) scale(${0.95 + glowFactor * 0.15})`;
        }

        const speed = 10 - (glowFactor * 6);
        ringOuter.style.animationDuration = `${speed}s`;
        if (ringInner) ringInner.style.animationDuration = `${speed}s`;
      }

      const fbLabel = document.getElementById('score-feedback');
      if (fbLabel) {
        if (currentScore > 85) {
          fbLabel.innerText = '神歌声 ✨';
          fbLabel.style.color = 'var(--glow-pink)';
        } else if (currentScore > 65) {
          fbLabel.innerText = '鳥肌! ⚡';
          fbLabel.style.color = 'var(--primary-neon)';
        } else if (currentScore > 40) {
          fbLabel.innerText = 'GOOD 🎵';
          fbLabel.style.color = 'var(--secondary-neon)';
        } else {
          fbLabel.innerText = isSongPlaying ? 'NOW SINGING' : 'STANDBY';
          fbLabel.style.color = 'var(--text-secondary)';
        }
      }
    }

    // Status bar: timer & heat readout
    if (isSongPlaying) {
      document.getElementById('live-timer').innerText = fmtTime((Date.now() - sessionStartTime) / 1000);
    }
    document.getElementById('streamer-heat-val').innerText = Math.round(heat);

    calculateStreamerScore();

    // Particles
    particles = particles.filter(p => {
      const active = p.update();
      if (active) {
        p.draw(stageCtx);
      } else if (p.life <= 0 && p.targetX !== null) {
        for (let i = 0; i < 8; i++) {
          particles.push(new Sparkle(coreX, coreY, p.color));
        }
      }
      return active || p.life > 0;
    });

    requestAnimationFrame(tickStreamer);
  }

  // --- Rendering Loop (Listener) ---
  function createLocalListenerParticles(x, y, type) {
    let color;
    switch (type) {
      case 'tear': color = '#60a5fa'; break;
      case 'goosebumps': color = '#fbbf24'; break;
      case 'god': color = '#a855f7'; break;
      case 'popopo': color = '#ec4899'; break;
      case 'donmai': color = '#7dd3fc'; break;
      default: color = '#ffffff';
    }

    for (let i = 0; i < 15; i++) {
      const p = new Sparkle(x, y, color);
      p.vx = (Math.random() - 0.5) * 12;
      p.vy = (Math.random() - 0.5) * 12 - 3;
      listenerParticles.push(p);
    }
  }

  function tickListener() {
    listenerCtx.clearRect(0, 0, listenerCanvas.width, listenerCanvas.height);

    if (comboCount > 0 && Date.now() - lastTapAt > 1500) {
      comboCount = 0;
      updateComboIndicator();
    }

    listenerParticles = listenerParticles.filter(p => {
      const active = p.update();
      if (active) {
        p.draw(listenerCtx);
      }
      return active;
    });

    // Floating emoji reactions from the whole room
    floatingEmojis = floatingEmojis.filter(f => {
      const active = f.update();
      if (active) {
        f.draw(listenerCtx);
      }
      return active;
    });

    requestAnimationFrame(tickListener);
  }
});
