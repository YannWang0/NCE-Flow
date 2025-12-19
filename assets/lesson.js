/**
 * NCE Flow · lesson.js · iOS-Optimized Edition
 */

(() => {
  // --------------------------
  // 工具 & 解析
  // --------------------------
  const LINE_RE = /^((?:\[\d+:\d+(?:\.\d+)?\])+)(.*)$/;
  const TIME_RE = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
  const META_RE = /^\[(al|ar|ti|by):(.+)\]$/i;

  function timeTagsToSeconds(tags) {
    const m = /\[(\d+):(\d+(?:\.\d+)?)\]/.exec(tags);
    if (!m) return 0;
    return parseInt(m[1], 10) * 60 + parseFloat(m[2]);
  }
  function hasCJK(s) { return /[\u3400-\u9FFF\uF900-\uFAFF]/.test(s) }
  async function fetchText(url) { const r = await fetch(url); if (!r.ok) throw new Error('Fetch failed ' + url); return await r.text(); }

  async function loadLrc(url) {
    const text = await fetchText(url);
    const rows = text.replace(/\r/g, '').split('\n');
    const meta = { al: '', ar: '', ti: '', by: '' };
    const items = [];
    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i].trim(); if (!raw) continue;
      const mm = raw.match(META_RE); if (mm) { meta[mm[1].toLowerCase()] = mm[2].trim(); continue; }
      const m = raw.match(LINE_RE); if (!m) continue;
      const tags = m[1];
      const start = timeTagsToSeconds(tags);
      let body = m[2].trim();
      let en = body, cn = '';
      if (body.includes('|')) { const parts = body.split('|'); en = parts[0].trim(); cn = (parts[1] || '').trim(); }
      else if (i + 1 < rows.length) {
        const m2 = rows[i + 1].trim().match(LINE_RE);
        if (m2 && m2[1] === tags) {
          const text2 = m2[2].trim();
          if (hasCJK(text2)) { cn = text2; i++; }
        }
      }
      items.push({ start, en, cn });
    }
    for (let i = 0; i < items.length; i++) items[i].end = i + 1 < items.length ? items[i + 1].start : 0;
    return { meta, items };
  }

  function qs(sel) { return document.querySelector(sel); }
  function once(target, type, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
      let to = 0;
      const on = (e) => { cleanup(); resolve(e); };
      const cleanup = () => { target.removeEventListener(type, on); if (to) clearTimeout(to); };
      target.addEventListener(type, on, { once: true });
      if (timeoutMs > 0) to = setTimeout(() => { cleanup(); reject(new Error(type + ' timeout')); }, timeoutMs);
    });
  }
  const raf = (cb) => requestAnimationFrame(cb);
  const raf2 = (cb) => requestAnimationFrame(() => requestAnimationFrame(cb));

  // iOS / iPadOS / 触屏 Mac Safari
  const ua = navigator.userAgent || '';
  const isIOSLike = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document);

  // --------------------------
  // 主流程
  // --------------------------
  document.addEventListener('DOMContentLoaded', () => {
    try { if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; } catch (_) {}
    window.scrollTo(0, 0);

    const hash = decodeURIComponent(location.hash.slice(1));
    if (!hash) { location.href = 'book.html'; return; }
    const [book, ...rest] = hash.split('/');
    const base = rest.join('/');
    const inModern = /\/modern\//.test(location.pathname);
    const prefix = inModern ? '../' : '';
    const mp3 = `${prefix}${book}/${base}.mp3`;
    const lrc = `${prefix}${book}/${base}.lrc`;

    const titleEl = qs('#lessonTitle');
    const subEl = qs('#lessonSub');
    const listEl = qs('#sentences');
    const audio = qs('#player');
    const backLink = qs('#backLink');
    const settingsBtn = qs('#settingsBtn');
    const settingsOverlay = qs('#settingsOverlay');
    const settingsPanel = qs('#settingsPanel');
    const settingsClose = qs('#settingsClose');
    const settingsDone = qs('#settingsDone');
	    const prevLessonLink = qs('#prevLesson');
	    const nextLessonLink = qs('#nextLesson');
	    const speedButton = qs('#speed');
	    const backToTopBtn = qs('#backToTop');

	    // 本地存储键
	    const RECENT_KEY = 'nce_recents';
	    const LASTPOS_KEY = 'nce_lastpos';
    const MODE_KEY = 'readMode';
    const FOLLOW_KEY = 'autoFollow';
    const AFTER_PLAY_KEY = 'afterPlay';
    const REVEALED_SENTENCES_KEY = 'nce_revealed_sentences';
    const SKIP_INTRO_KEY = 'skipIntro';

    // 状态
    let items = [];
    let idx = -1;
    let segmentEnd = 0;
    let segmentTimer = 0;
    let segmentRaf = 0;
    let isScheduling = false;
    let scheduleTime = 0;
    let internalPause = false;
    let segmentStartWallclock = 0;
    let prevLessonHref = '';
    let nextLessonHref = '';
    let _lastSavedAt = 0;
    let loopReplayPending = false;  // 标记是否正在等待循环重播
    let playSeq = 0;               // 防止异步 seek 回调串线

    // iOS 特有状态
    let iosUnlocked = false;         // 是否已“解锁音频”
    let metadataReady = false;       // 是否已 loadedmetadata
    let _userVolume = Math.max(0, Math.min(1, audio.volume || 1));

    // 音频 seek 兼容：当服务器不支持 Range 时，回退为 Blob URL（可在本地 http.server 正常点读）
    let audioBlobUrl = '';
    let audioBlobPromise = null;
    let usingBlobSrc = false;
    let warnedNoRange = false;

    // 速率
    const rates = [1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 0.75, 1.0];
    const DEFAULT_RATE = 1.0;
    let savedRate = parseFloat(localStorage.getItem('audioPlaybackRate'));
    if (isNaN(savedRate) || !rates.includes(savedRate)) savedRate = DEFAULT_RATE;
    let currentRateIndex = Math.max(0, rates.indexOf(savedRate));

    // 读取模式/跟随/播完后
    let readMode = localStorage.getItem(MODE_KEY) || 'continuous'; // 'continuous' | 'single' | 'listen'
    let autoFollow = localStorage.getItem(FOLLOW_KEY) === 'true'; // 默认关闭自动跟随
    let afterPlay = localStorage.getItem(AFTER_PLAY_KEY) || 'none'; // 'none' | 'single' | 'all' | 'next'
    let revealedSentences = new Set(); // 听读模式下已显示的句子索引
    let skipIntro = localStorage.getItem(SKIP_INTRO_KEY) === 'true'; // 是否跳过开头
    let firstContentIndex = 0; // 第一句正文的索引

    // 兼容旧版本：从旧的 loopMode 和 autoContinue 迁移
    if (!localStorage.getItem(AFTER_PLAY_KEY)) {
      const oldLoopMode = localStorage.getItem('loopMode');
      const oldAutoContinue = localStorage.getItem('autoContinue');

      if (oldAutoContinue === 'auto') {
        afterPlay = 'next';
      } else if (oldLoopMode === 'single') {
        afterPlay = 'single';
      } else if (oldLoopMode === 'all') {
        afterPlay = 'all';
      } else {
        afterPlay = 'none';
      }

	      try { localStorage.setItem(AFTER_PLAY_KEY, afterPlay); } catch(_) {}
	    }

	    // --------------------------
	    // Back to top button
	    // --------------------------
	    (function initBackToTop(){
	      if (!backToTopBtn) return;

	      const update = () => {
	        const y = window.scrollY || document.documentElement.scrollTop || 0;
	        const threshold = Math.min(320, window.innerHeight * 0.6);
	        const show = y > threshold;
	        backToTopBtn.classList.toggle('show', show);
	        backToTopBtn.setAttribute('aria-hidden', show ? 'false' : 'true');
	        backToTopBtn.tabIndex = show ? 0 : -1;
	      };

	      let ticking = false;
	      const onScroll = () => {
	        if (ticking) return;
	        ticking = true;
	        raf(() => { ticking = false; update(); });
	      };

	      backToTopBtn.addEventListener('click', () => {
	        try { window.scrollTo({ top: 0, behavior: 'smooth' }); }
	        catch(_) { window.scrollTo(0, 0); }
	      });

	      window.addEventListener('scroll', onScroll, { passive: true });
	      window.addEventListener('resize', onScroll, { passive: true });
	      update();
	    })();

	    // --------------------------
	    // iOS 解锁：首次任意交互即解锁
	    // --------------------------
    function unlockAudioSync() {
      if (iosUnlocked) return;
      try {
        audio.muted = true;            // 保证解锁过程无声
        const p = audio.play();        // 在同一用户手势栈内发起
        iosUnlocked = true;
        // 立即排队暂停与还原 mute（避免可闻 blip）
        setTimeout(() => { try { audio.pause(); } catch(_) {} audio.muted = false; }, 0);
      } catch (_) { iosUnlocked = false; }
    }
    if (isIOSLike) {
      const evs = ['pointerdown','touchstart','click'];
      const onceUnlock = (e) => { unlockAudioSync(); evs.forEach(t => document.removeEventListener(t, onceUnlock, true)); };
      evs.forEach(t => document.addEventListener(t, onceUnlock, { capture: true, passive: true, once: true }));
    }

    // 确保 metadata 已就绪（iOS 上 seek 前最好等）
    async function ensureMetadata() {
      if (metadataReady) return;
      try { await once(audio, 'loadedmetadata', 5000); metadataReady = true; }
      catch (_) { /* 忽略，后续 seek 仍会尽力 */ }
    }

    // --------------------------
    // 跳过开头：智能识别逻辑
    // --------------------------
    /**
     * 判断是否应该跳过某一行（高置信度检测）
     * @param {Object} item - 句子对象 {start, en, cn}
     * @param {number} index - 句子索引
     * @returns {boolean} - true 表示应该跳过
     */
    function shouldSkipLine(item, index) {
      const en = item.en.trim();
      const cn = item.cn ? item.cn.trim() : '';
      if (!en) return true; // 空行跳过

      // 规则1: 跳过 "Lesson X" + "第X课" 格式（已被解析分离）
      if (/^Lesson\s+\d+$/i.test(en) && /^第\d+课$/.test(cn)) {
        return true;
      }

      // 规则2: 跳过 "Listen to the tape then answer this question." (100% 置信度)
      if (/Listen to the tape/i.test(en)) {
        return true;
      }

      // 规则3: 跳过开头的课程标题（基于时间和内容特征）
      // 标题特征：有中文翻译，不是问句
      // 时间分布：标题(1.5-3s), 问题(7-15s，最早7.22s)
      if (cn && en.length < 80 && cn.length < 80) {
        // 情况1：时间 < 7秒 → 一定是标题，直接跳过
        if (item.start < 7) {
          return true;
        }
        // 情况2：时间 7-10秒 → 可能是标题或问题
        // 只有不是问号结尾才跳过（保护问题）
        if (item.start < 10 && !en.endsWith('?')) {
          return true;
        }
      }

      // 不跳过听力理解问题（通常以问号结尾，在 7-15 秒）

      return false;
    }

    /**
     * 找到第一句正文的索引（高置信度）
     * @param {Array} items - 所有句子
     * @returns {number} - 第一句正文的索引，如果无法确定则返回 0
     */
    function findFirstContentIndex(items) {
      if (!items || items.length === 0) return 0;

      // 只检查前 10 行，避免误判
      const checkLimit = Math.min(10, items.length);
      let skipCount = 0;

      for (let i = 0; i < checkLimit; i++) {
        if (shouldSkipLine(items[i], i)) {
          skipCount++;
        } else {
          // 找到了第一句正文
          // 但需要确保至少跳过了 1 行（避免误判导致什么都不跳）
          if (skipCount > 0) {
            console.log(`[跳过开头] 智能识别成功：跳过前 ${skipCount} 行，从索引 ${i} 开始播放`);
            return i;
          } else {
            // 第一行就是正文，不跳过
            console.log('[跳过开头] 第一行即为正文，不跳过');
            return 0;
          }
        }
      }

      // 如果前 10 行都被标记为跳过，说明识别可能有问题，保守起见不跳过
      console.log('[跳过开头] 未能确定第一句正文位置，为安全起见从头开始');
      return 0;
    }

    // --------------------------
    // UI 反映/设置
    // --------------------------
    function reflectReadMode() {
      const isContinuous = readMode === 'continuous';
      const isListen = readMode === 'listen';
      const isSingle = readMode === 'single';
      const continuousRadio = document.getElementById('readModeContinuous');
      const singleRadio = document.getElementById('readModeSingle');
      const listenRadio = document.getElementById('readModeListen');
      if (continuousRadio && singleRadio && listenRadio) {
        continuousRadio.checked = isContinuous;
        singleRadio.checked = isSingle;
        listenRadio.checked = isListen;
      }

      // 控制播完后选项的启用/禁用状态
      const afterPlaySingleRadio = document.getElementById('afterPlaySingle');
      const afterPlaySingleLabel = document.querySelector('label[for="afterPlaySingle"]');
      const afterPlayAllRadio = document.getElementById('afterPlayAll');
      const afterPlayAllLabel = document.querySelector('label[for="afterPlayAll"]');
      const afterPlayNextRadio = document.getElementById('afterPlayNext');
      const afterPlayNextLabel = document.querySelector('label[for="afterPlayNext"]');

      if (isContinuous) {
        // 连读模式：禁用"单句循环"（因为连读是自动播放下一句，和单句循环冲突）
        if (afterPlaySingleRadio) afterPlaySingleRadio.disabled = true;
        if (afterPlaySingleLabel) {
          afterPlaySingleLabel.style.opacity = '0.5';
          afterPlaySingleLabel.style.cursor = 'not-allowed';
        }
        // 启用"整篇循环"和"自动下一课"
        if (afterPlayAllRadio) afterPlayAllRadio.disabled = false;
        if (afterPlayAllLabel) {
          afterPlayAllLabel.style.opacity = '';
          afterPlayAllLabel.style.cursor = '';
        }
        if (afterPlayNextRadio) afterPlayNextRadio.disabled = false;
        if (afterPlayNextLabel) {
          afterPlayNextLabel.style.opacity = '';
          afterPlayNextLabel.style.cursor = '';
        }
        // 如果当前是单句循环，自动切换到本课结束
        if (afterPlay === 'single') {
          setAfterPlay('none');
        }
      } else if (isSingle) {
        // 点读模式：启用"单句循环"，禁用"整篇循环"和"自动下一课"
        // （因为点读模式播完就停，不会自动播完整篇）
        if (afterPlaySingleRadio) afterPlaySingleRadio.disabled = false;
        if (afterPlaySingleLabel) {
          afterPlaySingleLabel.style.opacity = '';
          afterPlaySingleLabel.style.cursor = '';
        }
        if (afterPlayAllRadio) afterPlayAllRadio.disabled = true;
        if (afterPlayAllLabel) {
          afterPlayAllLabel.style.opacity = '0.5';
          afterPlayAllLabel.style.cursor = 'not-allowed';
        }
        if (afterPlayNextRadio) afterPlayNextRadio.disabled = true;
        if (afterPlayNextLabel) {
          afterPlayNextLabel.style.opacity = '0.5';
          afterPlayNextLabel.style.cursor = 'not-allowed';
        }
        // 如果当前是整篇循环或自动下一课，自动切换到本课结束
        if (afterPlay === 'all' || afterPlay === 'next') {
          setAfterPlay('none');
        }
      } else if (isListen) {
        // 听读模式：所有"播完后"选项都可用
        // - 单句循环：用于反复听某一句做听力训练
        // - 整篇循环/自动下一课：自动播放模式
        if (afterPlaySingleRadio) afterPlaySingleRadio.disabled = false;
        if (afterPlaySingleLabel) {
          afterPlaySingleLabel.style.opacity = '';
          afterPlaySingleLabel.style.cursor = '';
        }
        if (afterPlayAllRadio) afterPlayAllRadio.disabled = false;
        if (afterPlayAllLabel) {
          afterPlayAllLabel.style.opacity = '';
          afterPlayAllLabel.style.cursor = '';
        }
        if (afterPlayNextRadio) afterPlayNextRadio.disabled = false;
        if (afterPlayNextLabel) {
          afterPlayNextLabel.style.opacity = '';
          afterPlayNextLabel.style.cursor = '';
        }
      }

      // 更新听读模式的 UI
      updateListenModeUI();
    }
    function reflectFollowMode() {
      const followOnRadio = document.getElementById('followOn');
      const followOffRadio = document.getElementById('followOff');
      if (followOnRadio && followOffRadio) {
        followOnRadio.checked = autoFollow;
        followOffRadio.checked = !autoFollow;
      }
    }
    function reflectAfterPlay() {
      const afterPlayNoneRadio = document.getElementById('afterPlayNone');
      const afterPlaySingleRadio = document.getElementById('afterPlaySingle');
      const afterPlayAllRadio = document.getElementById('afterPlayAll');
      const afterPlayNextRadio = document.getElementById('afterPlayNext');
      if (afterPlayNoneRadio && afterPlaySingleRadio && afterPlayAllRadio && afterPlayNextRadio) {
        afterPlayNoneRadio.checked = afterPlay === 'none';
        afterPlaySingleRadio.checked = afterPlay === 'single';
        afterPlayAllRadio.checked = afterPlay === 'all';
        afterPlayNextRadio.checked = afterPlay === 'next';
      }
    }
    function reflectSkipIntro() {
      const skipIntroOnRadio = document.getElementById('skipIntroOn');
      const skipIntroOffRadio = document.getElementById('skipIntroOff');
      if (skipIntroOnRadio && skipIntroOffRadio) {
        skipIntroOnRadio.checked = skipIntro;
        skipIntroOffRadio.checked = !skipIntro;
      }
    }
    reflectReadMode(); reflectFollowMode(); reflectAfterPlay(); reflectSkipIntro();

    function setReadMode(mode) {
      if (!['continuous', 'single', 'listen'].includes(mode)) mode = 'continuous';
      readMode = mode;
      try { localStorage.setItem(MODE_KEY, readMode); } catch(_) {}
      reflectReadMode();
      // 模式切换：清调度→按新模式刷新当前段末→重建调度
      clearAdvance(); isScheduling = false; scheduleTime = 0;
      if (idx >= 0 && idx < items.length) segmentEnd = endFor(items[idx]);
      scheduleAdvance();
    }
    function setFollowMode(follow) {
      autoFollow = !!follow;
      try { localStorage.setItem(FOLLOW_KEY, autoFollow.toString()); } catch(_) {}
      reflectFollowMode();
    }
    function setAfterPlay(mode) {
      if (!['none', 'single', 'all', 'next'].includes(mode)) mode = 'none';
      afterPlay = mode;
      try { localStorage.setItem(AFTER_PLAY_KEY, afterPlay); } catch(_) {}
      reflectAfterPlay();
    }
    function setSkipIntro(skip) {
      skipIntro = !!skip;
      try { localStorage.setItem(SKIP_INTRO_KEY, skipIntro.toString()); } catch(_) {}
      reflectSkipIntro();
      // 重新计算第一句正文的位置
      if (items && items.length > 0) {
        firstContentIndex = skipIntro ? findFirstContentIndex(items) : 0;
      }
    }
    function updateListenModeUI() {
      const isListenMode = readMode === 'listen';
      const sentences = listEl.querySelectorAll('.sentence');
      sentences.forEach((el, i) => {
        if (isListenMode) {
          el.classList.add('listen-mode');
          if (revealedSentences.has(i)) {
            el.classList.add('revealed');
          } else {
            el.classList.remove('revealed');
          }
        } else {
          el.classList.remove('listen-mode', 'revealed');
        }
      });
    }
    function toggleSentenceReveal(i) {
      if (readMode !== 'listen') return;
      if (revealedSentences.has(i)) {
        revealedSentences.delete(i);
      } else {
        revealedSentences.add(i);
      }
      // 保存到 localStorage（针对当前课程）
      saveRevealedSentences();
      updateListenModeUI();
    }
    function saveRevealedSentences() {
      try {
        const id = lessonId();
        const allRevealed = JSON.parse(localStorage.getItem(REVEALED_SENTENCES_KEY) || '{}');
        allRevealed[id] = Array.from(revealedSentences);
        localStorage.setItem(REVEALED_SENTENCES_KEY, JSON.stringify(allRevealed));
      } catch(_) {}
    }
    function loadRevealedSentences() {
      try {
        const id = lessonId();
        const allRevealed = JSON.parse(localStorage.getItem(REVEALED_SENTENCES_KEY) || '{}');
        const revealed = allRevealed[id] || [];
        revealedSentences = new Set(revealed);
      } catch(_) {
        revealedSentences = new Set();
      }
    }

    // 阅读模式单选按钮事件
    const readModeContinuous = document.getElementById('readModeContinuous');
    const readModeSingle = document.getElementById('readModeSingle');
    const readModeListen = document.getElementById('readModeListen');
    if (readModeContinuous) readModeContinuous.addEventListener('change', () => { if (readModeContinuous.checked) setReadMode('continuous'); });
    if (readModeSingle) readModeSingle.addEventListener('change', () => { if (readModeSingle.checked) setReadMode('single'); });
    if (readModeListen) readModeListen.addEventListener('change', () => { if (readModeListen.checked) setReadMode('listen'); });

    // 自动跟随单选按钮事件
    const followOn = document.getElementById('followOn');
    const followOff = document.getElementById('followOff');
    if (followOn) followOn.addEventListener('change', () => { if (followOn.checked) setFollowMode(true); });
    if (followOff) followOff.addEventListener('change', () => { if (followOff.checked) setFollowMode(false); });

    // 播完后单选按钮事件
    const afterPlayNoneRadio = document.getElementById('afterPlayNone');
    const afterPlaySingleRadio = document.getElementById('afterPlaySingle');
    const afterPlayAllRadio = document.getElementById('afterPlayAll');
    const afterPlayNextRadio = document.getElementById('afterPlayNext');

    if (afterPlayNoneRadio) afterPlayNoneRadio.addEventListener('change', () => { if (afterPlayNoneRadio.checked) setAfterPlay('none'); });

    if (afterPlaySingleRadio) {
      afterPlaySingleRadio.addEventListener('change', () => { if (afterPlaySingleRadio.checked) setAfterPlay('single'); });
      // 当禁用时点击，显示提示
      const afterPlaySingleLabel = document.querySelector('label[for="afterPlaySingle"]');
      if (afterPlaySingleLabel) {
        afterPlaySingleLabel.addEventListener('click', (e) => {
          if (afterPlaySingleRadio.disabled) {
            e.preventDefault();
            showNotification('单句循环在连读模式下不可用');
          }
        });
      }
    }

    if (afterPlayAllRadio) {
      afterPlayAllRadio.addEventListener('change', () => { if (afterPlayAllRadio.checked) setAfterPlay('all'); });
      // 当禁用时点击，显示提示
      const afterPlayAllLabel = document.querySelector('label[for="afterPlayAll"]');
      if (afterPlayAllLabel) {
        afterPlayAllLabel.addEventListener('click', (e) => {
          if (afterPlayAllRadio.disabled) {
            e.preventDefault();
            showNotification('整篇循环在点读模式下不可用');
          }
        });
      }
    }

    if (afterPlayNextRadio) {
      afterPlayNextRadio.addEventListener('change', () => { if (afterPlayNextRadio.checked) setAfterPlay('next'); });
      // 当禁用时点击，显示提示
      const afterPlayNextLabel = document.querySelector('label[for="afterPlayNext"]');
      if (afterPlayNextLabel) {
        afterPlayNextLabel.addEventListener('click', (e) => {
          if (afterPlayNextRadio.disabled) {
            e.preventDefault();
            showNotification('自动下一课在点读模式下不可用');
          }
        });
      }
    }

    // 跳过开头单选按钮事件
    const skipIntroOn = document.getElementById('skipIntroOn');
    const skipIntroOff = document.getElementById('skipIntroOff');
    if (skipIntroOn) skipIntroOn.addEventListener('change', () => { if (skipIntroOn.checked) setSkipIntro(true); });
    if (skipIntroOff) skipIntroOff.addEventListener('change', () => { if (skipIntroOff.checked) setSkipIntro(false); });

    // 倍速
    audio.playbackRate = savedRate;
    if (speedButton) speedButton.textContent = `${savedRate.toFixed(2)}x`;
    if (speedButton) speedButton.addEventListener('click', () => {
      currentRateIndex = (currentRateIndex + 1) % rates.length;
      const newRate = rates[currentRateIndex];
      audio.playbackRate = newRate;
    });
    audio.addEventListener('ratechange', () => {
      const r = audio.playbackRate;
      try { localStorage.setItem('audioPlaybackRate', r); } catch(_) {}
      if (speedButton) speedButton.textContent = `${r.toFixed(2)}x`;
      const i = rates.indexOf(r); if (i !== -1) currentRateIndex = i;
      scheduleAdvance();
    });

    function pauseForNavigation() {
      try { saveLastPos(); } catch (_) {}
      if (!audio.paused) {
        try { internalPause = true; audio.pause(); } catch (_) {}
      }
    }

    // 返回
    if (backLink) {
      const fallback = `index.html#${book}`;
      backLink.setAttribute('href', fallback);
      backLink.addEventListener('click', (e) => {
        e.preventDefault();
        pauseForNavigation();
        location.href = fallback;
      });
    }

    // --------------------------
    // 自定义播放器控制
    // --------------------------
    const playPauseBtn = qs('#playPauseBtn');
    const playIcon = playPauseBtn ? playPauseBtn.querySelector('.play-icon') : null;
    const pauseIcon = playPauseBtn ? playPauseBtn.querySelector('.pause-icon') : null;
    const currentTimeEl = qs('#currentTime');
    const durationEl = qs('#duration');
    const progressBar = qs('#progressBar');
    const progressFilled = qs('#progressFilled');

    // 格式化时间显示
    function formatTime(seconds) {
      if (!isFinite(seconds) || seconds < 0) return '0:00';
      const mins = Math.floor(seconds / 60);
      const secs = Math.floor(seconds % 60);
      return `${mins}:${String(secs).padStart(2, '0')}`;
    }

    // 更新播放/暂停图标
    function updatePlayPauseIcon() {
      if (!playIcon || !pauseIcon) return;
      if (audio.paused) {
        playIcon.style.display = '';
        pauseIcon.style.display = 'none';
      } else {
        playIcon.style.display = 'none';
        pauseIcon.style.display = '';
      }
    }

    // 播放/暂停按钮点击
    if (playPauseBtn) {
      playPauseBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if (audio.paused) {
          // 和空格键一样的逻辑：点读模式智能跳转
          if (readMode === 'single' && idx >= 0 && segmentEnd > 0) {
            const currentTime = audio.currentTime;
            const tolerance = 0.1;
            if (Math.abs(currentTime - segmentEnd) < tolerance) {
              const nextIdx = Math.min(idx + 1, items.length - 1);
              if (nextIdx < items.length && nextIdx !== idx) {
                playSegment(nextIdx, { manual: true });
                return;
              }
              playSegment(idx, { manual: true });
              return;
            }
          }
          if (idx < 0 && items.length > 0) {
            playSegment(firstContentIndex, { manual: true });
          } else {
            const p = audio.play();
            if (p && p.catch) p.catch(() => {});
          }
        } else {
          audio.pause();
        }
      });
    }

    // 更新进度条和时间显示
    function updateProgress() {
      const current = audio.currentTime || 0;
      const duration = audio.duration || 0;

      if (currentTimeEl) currentTimeEl.textContent = formatTime(current);
      if (durationEl) durationEl.textContent = formatTime(duration);

      if (progressFilled && duration > 0) {
        const percentage = (current / duration) * 100;
        progressFilled.style.width = `${Math.min(100, Math.max(0, percentage))}%`;
      }
    }

    // 进度条点击跳转
    if (progressBar) {
      progressBar.addEventListener('click', (e) => {
        const rect = progressBar.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const percentage = clickX / rect.width;
        const duration = audio.duration || 0;
        if (duration > 0) {
          audio.currentTime = percentage * duration;
        }
      });
    }

    // 监听audio事件更新UI
    audio.addEventListener('play', updatePlayPauseIcon);
    audio.addEventListener('pause', updatePlayPauseIcon);
    audio.addEventListener('timeupdate', updateProgress);
    audio.addEventListener('loadedmetadata', () => {
      updateProgress();
      updatePlayPauseIcon();
    });

    // 初始化播放器UI
    updateProgress();
    updatePlayPauseIcon();

    // 设置面板（沿用你的结构）
    let _prevFocus = null; let _trapHandler = null;
    function getFocusable(root){
      return root ? Array.from(root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
        .filter(el=>!el.hasAttribute('disabled') && el.offsetParent !== null) : [];
    }
    function enableTrap(){
      if (!settingsPanel) return;
      const fs = getFocusable(settingsPanel); if (fs.length) fs[0].focus();
      _trapHandler = (e)=>{
        if (e.key !== 'Tab') return;
        const list = getFocusable(settingsPanel); if (!list.length) return;
        const first = list[0], last = list[list.length - 1];
        if (e.shiftKey) { if (document.activeElement === first) { e.preventDefault(); last.focus(); } }
        else { if (document.activeElement === last) { e.preventDefault(); first.focus(); } }
      };
      document.addEventListener('keydown', _trapHandler);
    }
    function disableTrap(){ if (_trapHandler) { document.removeEventListener('keydown', _trapHandler); _trapHandler = null; } }
    function openSettings(){
      if (settingsOverlay) { settingsOverlay.hidden = false; requestAnimationFrame(()=>settingsOverlay.classList.add('show')); }
      if (settingsPanel)   { settingsPanel.hidden = false;   requestAnimationFrame(()=>settingsPanel.classList.add('show')); }
      try { _prevFocus = document.activeElement; } catch(_) {}
      try { document.body.style.overflow = 'hidden'; } catch(_) {}
      enableTrap();
    }
    function closeSettings(){
      disableTrap();
      if (settingsOverlay) { settingsOverlay.classList.remove('show'); setTimeout(()=>settingsOverlay.hidden = true, 200); }
      if (settingsPanel)   { settingsPanel.classList.remove('show');   setTimeout(()=>settingsPanel.hidden = true, 200); }
      try { document.body.style.overflow = ''; } catch(_) {}
      try { if (_prevFocus && _prevFocus.focus) _prevFocus.focus(); } catch(_) {}
    }
    if (settingsBtn)     settingsBtn.addEventListener('click', openSettings);
    if (settingsOverlay) settingsOverlay.addEventListener('click', closeSettings);
    if (settingsClose)   settingsClose.addEventListener('click', closeSettings);
    if (settingsDone)    settingsDone.addEventListener('click', closeSettings);

    // 快捷键帮助面板
    const shortcutsBtn = qs('#shortcutsToggle');
    const shortcutsOverlay = qs('#shortcutsOverlay');
    const shortcutsPanel = qs('#shortcutsPanel');
    const shortcutsClose = qs('#shortcutsClose');
    const shortcutsDone = qs('#shortcutsDone');

    function openShortcuts(){
      // 先立即关闭设置面板,避免两个面板叠加显示
      if (settingsPanel && !settingsPanel.hidden) {
        disableTrap();
        if (settingsOverlay) { settingsOverlay.classList.remove('show'); settingsOverlay.hidden = true; }
        if (settingsPanel) { settingsPanel.classList.remove('show'); settingsPanel.hidden = true; }
        try { document.body.style.overflow = ''; } catch(_) {}
      }
      if (shortcutsOverlay) { shortcutsOverlay.hidden = false; requestAnimationFrame(()=>shortcutsOverlay.classList.add('show')); }
      if (shortcutsPanel)   { shortcutsPanel.hidden = false;   requestAnimationFrame(()=>shortcutsPanel.classList.add('show')); }
      try { _prevFocus = document.activeElement; } catch(_) {}
      try { document.body.style.overflow = 'hidden'; } catch(_) {}
    }
    function closeShortcuts(){
      if (shortcutsOverlay) { shortcutsOverlay.classList.remove('show'); setTimeout(()=>shortcutsOverlay.hidden = true, 200); }
      if (shortcutsPanel)   { shortcutsPanel.classList.remove('show');   setTimeout(()=>shortcutsPanel.hidden = true, 200); }
      try { document.body.style.overflow = ''; } catch(_) {}
      try { if (_prevFocus && _prevFocus.focus) _prevFocus.focus(); } catch(_) {}
    }
    if (shortcutsBtn)     shortcutsBtn.addEventListener('click', openShortcuts);
    if (shortcutsOverlay) shortcutsOverlay.addEventListener('click', closeShortcuts);
    if (shortcutsClose)   shortcutsClose.addEventListener('click', closeShortcuts);
    if (shortcutsDone)    shortcutsDone.addEventListener('click', closeShortcuts);

    // 快捷键面板"返回设置"按钮
    const shortcutsBack = qs('#shortcutsBack');
    if (shortcutsBack) {
      shortcutsBack.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // 立即关闭快捷键面板
        if (shortcutsOverlay) { shortcutsOverlay.classList.remove('show'); shortcutsOverlay.hidden = true; }
        if (shortcutsPanel) { shortcutsPanel.classList.remove('show'); shortcutsPanel.hidden = true; }
        try { document.body.style.overflow = ''; } catch(_) {}
        // 立即打开设置面板
        openSettings();
      });
    }

    // Escape 键处理：优先关闭快捷键面板，然后关闭设置面板
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (shortcutsPanel && !shortcutsPanel.hidden) {
          closeShortcuts();
        } else {
          closeSettings();
        }
      }
    });

    // --------------------------
    // 全局快捷键
    // --------------------------
    // 音量提示UI
    let volumeToastTimer = 0;
    function showVolumeToast(volume) {
      const percentage = Math.round(volume * 100);
      let toast = document.getElementById('volumeToast');

      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'volumeToast';
        toast.style.cssText = `
          position: fixed;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          background: var(--surface);
          color: var(--text);
          border: 1px solid var(--border);
          border-radius: var(--radius);
          padding: 20px 30px;
          box-shadow: var(--shadow);
          z-index: 2000;
          backdrop-filter: saturate(120%) blur(10px);
          font-size: 18px;
          font-weight: 500;
          min-width: 120px;
          text-align: center;
          opacity: 0;
          transition: opacity 0.2s ease;
        `;
        document.body.appendChild(toast);
      }

      toast.textContent = `音量 ${percentage}%`;
      toast.style.opacity = '1';

      if (volumeToastTimer) clearTimeout(volumeToastTimer);
      volumeToastTimer = setTimeout(() => {
        toast.style.opacity = '0';
      }, 1000);
    }

    document.addEventListener('keydown', (e) => {
      // 避免在输入框中触发快捷键
      const target = e.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }

      // ? 键 - 打开/关闭快捷键帮助
      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault();
        if (shortcutsPanel && !shortcutsPanel.hidden) {
          closeShortcuts();
        } else {
          openShortcuts();
        }
        return;
      }

      // ArrowUp - 音量增加（优先处理，避免和其他按键冲突）
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const newVolume = Math.min(1, audio.volume + 0.1);
        audio.volume = newVolume;
        try { localStorage.setItem('nce_volume', newVolume); } catch(_) {}
        showVolumeToast(newVolume);
        return;
      }

      // ArrowDown - 音量减少（优先处理，避免和其他按键冲突）
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const newVolume = Math.max(0, audio.volume - 0.1);
        audio.volume = newVolume;
        try { localStorage.setItem('nce_volume', newVolume); } catch(_) {}
        showVolumeToast(newVolume);
        return;
      }

      // Space - 播放/暂停
      if (e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        if (audio.paused) {
          // 点读模式下的智能跳转：如果当前在句末（说明是自动暂停的），跳到下一句
          if (readMode === 'single' && idx >= 0 && segmentEnd > 0) {
            const currentTime = audio.currentTime;
            const tolerance = 0.1; // 容错范围 100ms
            // 判断是否在当前句末尾（自动暂停的位置）
            if (Math.abs(currentTime - segmentEnd) < tolerance) {
              // 在句末，跳到下一句
              const nextIdx = Math.min(idx + 1, items.length - 1);
              if (nextIdx < items.length && nextIdx !== idx) {
                playSegment(nextIdx, { manual: true });
                return;
              }
              // 如果已经是最后一句，则重播当前句
              playSegment(idx, { manual: true });
              return;
            }
          }

          // 其他情况：正常播放
          if (idx < 0 && items.length > 0) {
            // 如果没有选中任何句子，从第一句正文开始
            playSegment(firstContentIndex, { manual: true });
          } else {
            const p = audio.play();
            if (p && p.catch) p.catch(() => {});
          }
        } else {
          audio.pause();
        }
        return;
      }

      // ArrowRight 或 D - 下一句
      if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        const nextIdx = idx < 0 ? firstContentIndex : Math.min(idx + 1, items.length - 1);
        if (nextIdx < items.length) {
          playSegment(nextIdx, { manual: true });
        }
        return;
      }

      // ArrowLeft 或 A - 上一句
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        const prevIdx = idx < 0 ? firstContentIndex : Math.max(idx - 1, 0);
        if (prevIdx >= 0) {
          playSegment(prevIdx, { manual: true });
        }
        return;
      }

      // R - 重播当前句
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        if (idx >= 0 && idx < items.length) {
          playSegment(idx, { manual: true });
        } else if (items.length > 0) {
          // 如果没有当前句，播放第一句正文
          playSegment(firstContentIndex, { manual: true });
        }
        return;
      }

      // V - 切换当前句显示/隐藏（听读模式）
      if (e.key === 'v' || e.key === 'V') {
        e.preventDefault();
        if (readMode === 'listen' && idx >= 0 && idx < items.length) {
          toggleSentenceReveal(idx);
        }
        return;
      }
    });

    const settingsReset = qs('#settingsReset');
    if (settingsReset){
      settingsReset.addEventListener('click', ()=>{
        try{ localStorage.setItem('audioPlaybackRate', DEFAULT_RATE); }catch(_){}
        audio.playbackRate = DEFAULT_RATE;
        setReadMode('continuous'); setFollowMode(false); setAfterPlay('none'); setSkipIntro(false);
        reflectReadMode(); reflectFollowMode(); reflectAfterPlay(); reflectSkipIntro();
        showNotification('已恢复默认设置');
      });
    }

    // --------------------------
    // 渲染 & 端点计算
    // --------------------------
    function render() {
      const html = items.map((it, i) => `
        <div class="sentence" data-idx="${i}">
          <button class="reveal-btn" data-idx="${i}" aria-label="显示/隐藏文本">
            <span class="reveal-icon">👁</span>
            <span class="reveal-text">显示</span>
          </button>
          <div class="en">${it.en}</div>
          ${it.cn ? `<div class="cn">${it.cn}</div>` : ''}
        </div>
      `).join('');
      qs('#sentences').innerHTML = html;
      // 渲染后立即更新听力模式 UI
      updateListenModeUI();
    }

    function computeEnd(it) {
      const fallback = 0.2; // 连读最小时长
      if (it.end && it.end > it.start) return it.end;
      return Math.max(0, (it.start || 0) + fallback);
    }
    // 单句模式提前量，参考老版本：提前 0.5s 结束，避免读到下一句的前缀
    const SINGLE_CUTOFF = 0.5;
    const MIN_SEG_DUR = 0.2;
    function endFor(it) {
      if (readMode === 'single') {
        // 取下一句开始时间作为结束基准，并减去提前量
        let baseEnd = 0;
        if (it.end && it.end > it.start) baseEnd = it.end;
        else {
          const i = items ? items.indexOf(it) : -1;
          if (i >= 0 && i + 1 < items.length) baseEnd = items[i + 1].start || 0;
        }
        // 计算单句的目标结束时间：基准-提前量，且不小于最小时长
        if (baseEnd > 0) {
          const e = Math.max(it.start + MIN_SEG_DUR, baseEnd - SINGLE_CUTOFF);
          return e;
        }
        // 无可用基准：给一个保守默认值
        return it.start + 0.5;
      }
      return computeEnd(it);
    }

    // --------------------------
    // 调度：远端定时 + 近端 rAF
    // --------------------------
    function clearAdvance() {
      if (segmentTimer) { clearTimeout(segmentTimer); segmentTimer = 0; }
      if (segmentRaf)   { cancelAnimationFrame(segmentRaf); segmentRaf = 0; }
    }
    function guardAheadSec() {
      const r = Math.max(0.5, Math.min(3, audio.playbackRate || 1));
      // iOS 略保守：基础 80ms，倍速升高再加裕度，上限约 120ms
      const base = isIOSLike ? 0.08 : 0.06;
      const slope = isIOSLike ? 0.03 : 0.02;
      return base + (r - 1) * slope;
    }
    const NEAR_WINDOW_MS = isIOSLike ? 160 : 120;
    const MAX_CHUNK_MS   = 10000;

    function scheduleAdvance() {
      clearAdvance(); isScheduling = false; scheduleTime = 0;
      if (audio.paused) return;
      // 连读模式或听读模式（非单句循环）下不做逐句调度，避免 iOS 在边界 seek 造成的卡顿
      if (readMode === 'continuous' || (readMode === 'listen' && afterPlay !== 'single')) return;
      if (!(segmentEnd && idx >= 0)) return;

      const rate = Math.max(0.0001, audio.playbackRate || 1);
      const remainingMs = Math.max(0, (segmentEnd - audio.currentTime) * 1000 / rate);
      scheduleTime = segmentEnd;
      const modeSnap = readMode;

      // 近端窗口：rAF 精确判断
      if (remainingMs <= NEAR_WINDOW_MS) {
        isScheduling = true;
        const endSnap = segmentEnd;
        const guard = guardAheadSec();
        const step = () => {
          if (readMode !== modeSnap || audio.paused || !(segmentEnd && idx >= 0)) { isScheduling = false; return; }
          const now = audio.currentTime;
          if (now >= endSnap - guard) {
            isScheduling = false; scheduleTime = 0;

            // 点读：暂停在段末
            console.log('[循环调试] scheduleAdvance到达段末，暂停播放', {
              idx,
              afterPlay,
              loopReplayPending,
              currentTime: audio.currentTime,
              segmentEnd: endSnap
            });
            audio.pause();
            audio.currentTime = endSnap;

            // 单句循环：标记循环等待，稍后重播
            if (afterPlay === 'single' && idx >= 0 && idx < items.length && !loopReplayPending) {
              console.log('[循环调试] 设置单句循环重播，300ms后执行');
              loopReplayPending = true;
              setTimeout(() => {
                console.log('[循环调试] 300ms后检查循环条件', {
                  loopReplayPending,
                  afterPlay,
                  idx
                });
                if (loopReplayPending && afterPlay === 'single') {
                  loopReplayPending = false;
                  console.log('[循环调试] 开始执行循环重播 playSegment');
                  playSegment(idx, { manual: false });
                } else {
                  console.log('[循环调试] 循环条件不满足，取消重播');
                }
              }, 300);
            } else {
              console.log('[循环调试] 不满足循环条件，不设置重播', {
                afterPlay,
                loopReplayPending,
                idx
              });
            }
          } else {
            segmentRaf = raf(step);
          }
        };
        segmentRaf = raf(step);
        return;
      }

      // 远端窗口：coarse timer
      const delay = Math.max(10, Math.min(remainingMs, MAX_CHUNK_MS));
      isScheduling = true;
      segmentTimer = setTimeout(function tick() {
        if (readMode !== modeSnap || audio.paused || !(segmentEnd && idx >= 0)) { isScheduling = false; return; }
        const now = audio.currentTime;
        const end = segmentEnd;
        const remainRealMs = Math.max(0, (end - now) * 1000 / Math.max(0.0001, audio.playbackRate || 1));

        if (remainRealMs <= NEAR_WINDOW_MS) {
          isScheduling = false; scheduleAdvance(); return;
        }
        const rate2 = Math.max(0.0001, audio.playbackRate || 1);
        const nextDelay = Math.max(10, Math.min(Math.max(0, (end - audio.currentTime) * 1000 / rate2), MAX_CHUNK_MS));
        segmentTimer = setTimeout(tick, nextDelay);
      }, delay);
    }

    // --------------------------
    // 无缝切句 / 播放控制
    // --------------------------
    function fastSeekTo(t) {
      if (typeof audio.fastSeek === 'function') {
        try { audio.fastSeek(t); } catch(_) { audio.currentTime = t; }
      } else {
        audio.currentTime = t;
      }
    }

    const SEEK_OK_EPS = 0.25;
    const SEEK_TIMEOUT_MS = isIOSLike ? 2500 : 1200;

    function seekLooksOk(target, actual) {
      if (!Number.isFinite(target) || target <= 0.5) return true;
      return Math.abs((actual || 0) - target) <= SEEK_OK_EPS;
    }

    async function getAudioBlobUrl() {
      if (audioBlobUrl) return audioBlobUrl;
      if (audioBlobPromise) return await audioBlobPromise;
      audioBlobPromise = (async () => {
        const r = await fetch(mp3);
        if (!r.ok) throw new Error('Fetch audio failed: ' + r.status);
        const blob = await r.blob();
        audioBlobUrl = URL.createObjectURL(blob);
        return audioBlobUrl;
      })();
      try { return await audioBlobPromise; }
      finally { if (!audioBlobUrl) audioBlobPromise = null; }
    }

    async function switchToBlobSource() {
      if (usingBlobSrc) return true;
      try {
        const url = await getAudioBlobUrl();
        const keepRate = audio.playbackRate || 1;
        const keepVol = audio.volume;
        const keepMuted = audio.muted;

        metadataReady = false;
        audio.src = url;
        try { audio.load(); } catch(_) {}
        await ensureMetadata();

        try { audio.playbackRate = keepRate; } catch(_) {}
        try { audio.volume = keepVol; } catch(_) {}
        try { audio.muted = keepMuted; } catch(_) {}

        usingBlobSrc = true;
        return true;
      } catch (e) {
        console.error('[音频] 切换为 Blob 失败', e);
        return false;
      }
    }

    async function playSegment(i, opts) {
      const manual = !!(opts && opts.manual);
      console.log('[循环调试] playSegment调用', {
        idx: i,
        manual,
        currentIdx: idx,
        loopReplayPending,
        paused: audio.paused
      });

      if (i < 0 || i >= items.length) return;
      const mySeq = ++playSeq;

      // 手动操作时清除循环等待标志
      if (manual && loopReplayPending) {
        console.log('[循环调试] 手动操作，清除循环等待标志');
        loopReplayPending = false;
      }

      // 自动流程：同句且已在播不重复
      if (!manual && idx === i && !audio.paused) {
        console.log('[循环调试] 自动流程跳过：同句且正在播放');
        return;
      }

      // iOS：点击句子也要能“第一次就播”
      if (isIOSLike && !iosUnlocked) unlockAudioSync();

      // 在 iOS 上，seek 前优先确保 metadata
      await ensureMetadata();

      clearAdvance(); isScheduling = false; scheduleTime = 0;
      idx = i;
      const it = items[i];
      let start = Math.max(0, it.start || 0);
      segmentEnd = endFor(it);
      segmentStartWallclock = performance.now();
      highlight(i, manual);

      const cur = Math.max(0, audio.currentTime || 0);
      // 自动前进且"新起点过近"时，给极小前移，避免抖动
      // 但循环重播(同句)时不应用此逻辑，必须回到真实起点
      const isLoopReplay = (!manual && idx === i);
      if (!manual && !isLoopReplay && start <= cur + 0.005) {
        const dur = Number(audio.duration);
        const eps = 0.005;
        start = Math.min(Number.isFinite(dur) ? Math.max(0, dur - 0.05) : start + eps, cur + eps);
      }

      if (!manual && (readMode === 'continuous' || (readMode === 'listen' && afterPlay !== 'single')) && !audio.paused) {
        // 连读或听读（非单句循环）：保持播放，静音→seek→(seeked/canplay)→两帧后解除静音→调度
        audio.muted = true;
        let done = false;
        const finish = () => {
          if (done) return; done = true;
          audio.removeEventListener('seeked', finish);
          audio.removeEventListener('canplay', finish);
          raf2(() => { audio.muted = false; scheduleAdvance(); });
        };
        audio.addEventListener('seeked', finish, { once: true });
        audio.addEventListener('canplay', finish, { once: true });
        fastSeekTo(start);
      } else {
        // 点读或听读（单句循环）/初次播放：暂停→seek→seeked 后 play（不使用固定延时）
        try { internalPause = true; audio.pause(); } catch(_) {}
        const target = start;
        let retries = 0;
        let blobTried = false;

        const attemptSeek = async () => {
          if (mySeq !== playSeq) return;
          let settled = false;
          const onDone = async () => {
            if (settled) return;
            settled = true;
            audio.removeEventListener('seeked', onDone);
            if (mySeq !== playSeq) return;

            const actual = Math.max(0, audio.currentTime || 0);
            if (!seekLooksOk(target, actual)) {
              retries++;
              if (retries <= 2) { attemptSeek(); return; }
              if (!blobTried && !usingBlobSrc) {
                blobTried = true;
                if (!warnedNoRange) {
                  warnedNoRange = true;
                  showNotification('当前服务器不支持音频跳转，已切换为完整音频加载以启用点读');
                }
                const ok = await switchToBlobSource();
                if (ok && mySeq === playSeq) { retries = 0; attemptSeek(); return; }
              }
            }

            const p = audio.play(); if (p && p.catch) p.catch(()=>{});
            raf2(() => scheduleAdvance());
          };
          audio.addEventListener('seeked', onDone, { once: true });
          fastSeekTo(target);
          setTimeout(onDone, SEEK_TIMEOUT_MS);
        };

        attemptSeek();
      }
    }

    // --------------------------
    // 高亮 & 跟随
    // --------------------------
    let scrollTimer = 0;
    function scheduleScrollTo(el, manual){
      if (!el) return;
      if (scrollTimer) { clearTimeout(scrollTimer); scrollTimer = 0; }
      if (!autoFollow) return;
      if (manual) { try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch(_) {} return; }
      scrollTimer = setTimeout(() => { try { el.scrollIntoView({ behavior: 'auto', block: 'center' }); } catch(_) {} }, 420);
    }
    function highlight(i, manual=false) {
      const prev = listEl.querySelector('.sentence.active'); if (prev) prev.classList.remove('active');
      const cur = listEl.querySelector(`.sentence[data-idx="${i}"]`);
      if (cur) { cur.classList.add('active'); scheduleScrollTo(cur, manual); }
    }
    listEl.addEventListener('click', e => {
      // 检查是否点击了显示/隐藏按钮
      const revealBtn = e.target.closest('.reveal-btn');
      if (revealBtn) {
        e.preventDefault();
        e.stopPropagation();
        const clickedIdx = parseInt(revealBtn.dataset.idx, 10);
        if (readMode === 'listen') {
          toggleSentenceReveal(clickedIdx);
        }
        return;
      }

      const s = e.target.closest('.sentence'); if (!s) return;
      const clickedIdx = parseInt(s.dataset.idx, 10);

      // 触发播放（听读模式和普通模式都支持）
      // 确保"首次点句"也能触发 iOS 解锁
      if (isIOSLike && !iosUnlocked) unlockAudioSync();
      playSegment(clickedIdx, { manual: true });
    });

    // 双击事件：听读模式下显示文本
    listEl.addEventListener('dblclick', e => {
      const s = e.target.closest('.sentence'); if (!s) return;
      const clickedIdx = parseInt(s.dataset.idx, 10);

      if (readMode === 'listen' && !revealedSentences.has(clickedIdx)) {
        toggleSentenceReveal(clickedIdx);
      }
    });

    // --------------------------
    // 轻量 timeupdate：优先做点读安全停止，其次做高亮/存档
    // --------------------------
    let lastUpdateTime = 0;
    audio.addEventListener('timeupdate', () => {
      const t = audio.currentTime;
      // 点读模式或听读模式（单句循环）安全网：如果 scheduleAdvance 失效，这里兜底暂停
      if ((readMode === 'single' || (readMode === 'listen' && afterPlay === 'single')) && segmentEnd && t >= segmentEnd && !audio.paused) {
        audio.pause();
        audio.currentTime = segmentEnd;
        // 直接返回，避免本次循环内再做额外计算
        return;
      }

      const now = performance.now();
      if (now - lastUpdateTime < 200) return;
      lastUpdateTime = now;

      // 段首 350ms 内避免重活，降低抖动（不影响上面的点读安全停止）
      if (segmentStartWallclock && now - segmentStartWallclock < 350) return;

      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const segEnd = endFor(it);
        const within = t >= it.start && (segEnd ? t < segEnd : true);
        if (within) {
          if (idx !== i) { idx = i; segmentEnd = segEnd; highlight(i); }
          break;
        }
      }

      if (now - _lastSavedAt > 2000) { _lastSavedAt = now; saveLastPos(); }
    });

    // 播放/暂停
    audio.addEventListener('pause', () => {
      console.log('[循环调试] audio.pause事件触发', {
        internalPause,
        loopReplayPending,
        idx,
        currentTime: audio.currentTime
      });
      clearAdvance(); isScheduling = false; scheduleTime = 0;
      if (!internalPause) saveLastPos(true);
      internalPause = false;
      if (scrollTimer) { clearTimeout(scrollTimer); scrollTimer = 0; }
    });
    audio.addEventListener('play', () => {
      console.log('[循环调试] audio.play事件触发', {
        idx,
        loopReplayPending,
        currentTime: audio.currentTime
      });
      setTimeout(() => scheduleAdvance(), 50);
      touchRecent();
      internalPause = false;
    });

    // 进度变更：重建调度
    audio.addEventListener('seeked', () => {
      clearAdvance(); isScheduling = false; scheduleTime = 0; scheduleAdvance();
    });

    // 整体结束
    audio.addEventListener('ended', () => {
      // 整篇循环：从第一句正文重新开始（连读/听读模式）
      if ((readMode === 'continuous' || readMode === 'listen') && afterPlay === 'all' && items.length > 0) {
        setTimeout(() => {
          playSegment(firstContentIndex, { manual: true });
        }, 100);
        return;
      }

      // 自动下一课（仅在未开启整篇循环时，连读/听读模式）
      if ((readMode === 'continuous' || readMode === 'listen') && afterPlay === 'next') {
        autoNextLesson();
      }
    });

    // --------------------------
    // 邻接课程与跳转
    // --------------------------
    async function getNextLesson(currentBook, currentFilename) {
      try {
        const response = await fetch(prefix + 'static/data.json');
        if (!response.ok) return null;
        const data = await response.json();
        const bookNum = parseInt(currentBook.replace('NCE', '')) || 1;
        const lessons = data[bookNum] || [];
        const currentIndex = lessons.findIndex(lesson => lesson.filename === currentFilename);
        if (currentIndex >= 0 && currentIndex < lessons.length - 1) return lessons[currentIndex + 1];
        return null;
      } catch (e) { console.error(e); return null; }
    }
    function showNotification(message) {
      const n = document.createElement('div');
      n.style.cssText = `
        position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
        background: var(--surface); color: var(--text); border: 1px solid var(--border);
        border-radius: var(--radius); padding: 12px 20px; box-shadow: var(--shadow);
        z-index: 1000; backdrop-filter: saturate(120%) blur(10px); animation: slideDown 0.3s ease-out;
      `;
      n.textContent = message; document.body.appendChild(n);
      setTimeout(()=>{ n.style.animation='slideUp 0.3s ease-out'; setTimeout(()=>{ document.body.removeChild(n); },300); },2000);
    }
    async function autoNextLesson() {
      const nextLesson = await getNextLesson(book, base);
      if (nextLesson) {
        showNotification(`即将跳转到下一课：${nextLesson.title}`);
        setTimeout(() => {
          try {
            const nextId = `${book}/${nextLesson.filename}`;
            sessionStorage.setItem('nce_resume', nextId);
            sessionStorage.setItem('nce_resume_play', '1');
            const map = JSON.parse(localStorage.getItem(LASTPOS_KEY) || '{}');
            map[nextId] = { t: 0, idx: 0, ts: Date.now() };
            localStorage.setItem(LASTPOS_KEY, JSON.stringify(map));
          } catch(_) {}
          window.location.href = `lesson.html#${book}/${nextLesson.filename}`;
        }, 2000);
      } else {
        showNotification('🎉 恭喜完成本册课程！');
      }
    }
    async function resolveLessonNeighbors() {
      try {
        const num = parseInt(book.replace('NCE', '')) || 1;
        const res = await fetch(prefix + 'static/data.json');
        const data = await res.json();
        const lessons = data[num] || [];
        const i = lessons.findIndex(x => x.filename === base);
        if (i > 0) {
          const prev = lessons[i - 1].filename;
          prevLessonHref = `lesson.html#${book}/${prev}`;
          if (prevLessonLink) { prevLessonLink.href = prevLessonHref; prevLessonLink.style.display = ''; }
        } else { if (prevLessonLink) prevLessonLink.style.display = 'none'; }
        if (i >= 0 && i + 1 < lessons.length) {
          const next = lessons[i + 1].filename;
          nextLessonHref = `lesson.html#${book}/${next}`;
          if (nextLessonLink) { nextLessonLink.href = nextLessonHref; nextLessonLink.style.display = ''; }
        } else { if (nextLessonLink) nextLessonLink.style.display = 'none'; }
      } catch (_) {
        if (prevLessonLink) prevLessonLink.style.display = 'none';
        if (nextLessonLink) nextLessonLink.style.display = 'none';
      }
    }

    // --------------------------
    // 启动：装载音频/LRC + 断点恢复
    // --------------------------
    // 恢复保存的音量
    try {
      const savedVolume = parseFloat(localStorage.getItem('nce_volume'));
      if (!isNaN(savedVolume) && savedVolume >= 0 && savedVolume <= 1) {
        audio.volume = savedVolume;
      }
    } catch(_) {}

    // 重要：iOS 上尽早设定 preload，有助于更快拿到 metadata
    try { audio.preload = 'auto'; } catch(_) {}
    audio.src = mp3;
    try { audio.load(); } catch(_) {}

    if (window.NCE_APP && typeof NCE_APP.initSegmented === 'function') {
      try { NCE_APP.initSegmented(document); } catch(_) {}
    }

    resolveLessonNeighbors();

    let _lastEndAdjusted = false;
    function adjustLastEndIfPossible() {
      if (_lastEndAdjusted) return;
      if (!items || !items.length) return;
      const dur = Number(audio.duration);
      if (!Number.isFinite(dur) || dur <= 0) return;
      const last = items[items.length - 1];
      if (!last.end || last.end <= last.start || last.end > dur) {
        last.end = dur;
        if (idx === items.length - 1) segmentEnd = computeEnd(last);
      }
      _lastEndAdjusted = true;
    }
    audio.addEventListener('loadedmetadata', () => {
      metadataReady = true;
      adjustLastEndIfPossible();
      // 重新应用保存的播放速度（某些浏览器在 load() 后会重置 playbackRate）
      if (savedRate && audio.playbackRate !== savedRate) {
        audio.playbackRate = savedRate;
      }
    });

    function lessonId(){ return `${book}/${base}`; }
    function touchRecent(){
      try{
        const id = lessonId(); const now = Date.now();
        const raw = JSON.parse(localStorage.getItem(RECENT_KEY)||'[]');
        const rest = raw.filter(x=>x && x.id !== id);
        const next = [{ id, ts: now }, ...rest].slice(0, 60);
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      }catch(_){}
    }
    function saveLastPos(){
      try{
        const id = lessonId(); const now = Date.now();
        const map = JSON.parse(localStorage.getItem(LASTPOS_KEY)||'{}');
        map[id] = { t: Math.max(0, audio.currentTime||0), idx: Math.max(0, idx|0), ts: now };
        localStorage.setItem(LASTPOS_KEY, JSON.stringify(map));
      }catch(_){}
    }

    loadLrc(lrc).then(({ meta, items: arr }) => {
      items = arr;
      const lessonTitle = meta.ti || base;
      titleEl.textContent = lessonTitle;
      subEl.textContent = `${meta.al || book} · ${meta.ar || ''}`.trim();

      // 更新浏览器标签页标题
      document.title = `${lessonTitle} - NCE Flow`;

      // 智能识别第一句正文的位置
      firstContentIndex = skipIntro ? findFirstContentIndex(items) : 0;

      render();
      touchRecent();
      adjustLastEndIfPossible();

      // 加载已显示的句子记录（听力模式）
      loadRevealedSentences();
      updateListenModeUI();

      // 从上一课或首页跳转来的自动恢复
      try{
        const resumeId = sessionStorage.getItem('nce_resume');
        if (resumeId && resumeId === lessonId()){
          const map = JSON.parse(localStorage.getItem(LASTPOS_KEY)||'{}');
          const pos = map[resumeId];
          if (pos){
            let targetIdx = (Number.isInteger(pos.idx) && pos.idx>=0 && pos.idx<items.length) ? pos.idx : 0;

            // 如果启用了跳过开头，且保存的位置在跳过区域内，则从第一句正文开始
            let targetTime = Math.max(0, pos.t || 0);
            if (skipIntro && targetIdx < firstContentIndex) {
              targetIdx = firstContentIndex;
              targetTime = items[firstContentIndex].start || 0;
              console.log(`[跳过开头] 断点恢复：保存的位置 ${pos.idx} 在跳过区域内，从索引 ${firstContentIndex}（时间 ${targetTime}s）开始播放`);
            }

            audio.currentTime = targetTime;
            idx = targetIdx; segmentEnd = endFor(items[targetIdx]);
            highlight(targetIdx, false);
            if (sessionStorage.getItem('nce_resume_play')==='1'){
              const p = audio.play(); if (p && p.catch) p.catch(()=>{});
              scheduleAdvance();
            }
          }
        }
      }catch(_){}
      sessionStorage.removeItem('nce_resume');
      sessionStorage.removeItem('nce_resume_play');
    }).catch(err => {
      titleEl.textContent = '无法加载课文';
      subEl.textContent = String(err);
    });

    window.addEventListener('pagehide', () => { pauseForNavigation(); });
    window.addEventListener('beforeunload', ()=>{ saveLastPos(); try { if (audioBlobUrl) URL.revokeObjectURL(audioBlobUrl); } catch(_) {} });
    window.addEventListener('hashchange', () => { window.scrollTo(0, 0); location.reload(); });
  });
})();

// --------------------------
// Particle Background Animation
// --------------------------
(function(){
  const cvs = document.getElementById('bg-canvas');
  if (!cvs) return;

  const ctx = cvs.getContext('2d'),
        dpr = window.devicePixelRatio || 1;
  let w, h, particles = [];

  function resize(){
    w = cvs.width  = innerWidth  * dpr;
    h = cvs.height = innerHeight * dpr;
    ctx.scale(dpr, dpr);
    cvs.style.width  = innerWidth  + 'px';
    cvs.style.height = innerHeight + 'px';
  }
  window.addEventListener('resize', resize);

  class Particle {
    constructor(){
      this.x = Math.random() * innerWidth;
      this.y = Math.random() * innerHeight;
      this.vx = (Math.random() - .5) * .3;
      this.vy = (Math.random() - .5) * .3;
      this.r = Math.random() * 1.2 + .5;
    }
    update(){
      this.x += this.vx;
      this.y += this.vy;
      if(this.x < 0 || this.x > innerWidth) this.vx *= -1;
      if(this.y < 0 || this.y > innerHeight) this.vy *= -1;
    }
    draw(){
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.r, 0, Math.PI*2);
      ctx.fillStyle = isDark() ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.25)';
      ctx.fill();
    }
  }

  function isDark(){
    return document.body.classList.contains('dark-theme');
  }

  function drawLines(){
    for(let i=0;i<particles.length;i++){
      for(let j=i+1;j<particles.length;j++){
        const dx = particles[i].x - particles[j].x,
              dy = particles[i].y - particles[j].y,
              dist = Math.sqrt(dx*dx + dy*dy);
        if(dist < 100){
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = isDark()
            ? `rgba(255,255,255,${1-dist/100})`
            : `rgba(0,0,0,${.5-dist/200})`;
          ctx.lineWidth = .5;
          ctx.stroke();
        }
      }
    }
  }

  function init(){
    resize();
    particles = Array.from({length: Math.floor(innerWidth*innerHeight/18000)}, ()=>new Particle());
    animate();
  }

  function animate(){
    ctx.clearRect(0,0,innerWidth,innerHeight);
    particles.forEach(p=>{p.update();p.draw();});
    drawLines();
    requestAnimationFrame(animate);
  }

  init();
})();
