/* ============================================================================
   scroll-world — portable scroll-scrubbed camera-flight engine
   ----------------------------------------------------------------------------
   Framework-agnostic. Vanilla JS, zero dependencies. It builds its own DOM and
   injects its own (namespaced) CSS into a container you give it, so it drops into
   plain HTML, Next.js (call from a ref/useEffect), Vue (onMounted), a server-
   rendered page, anything.

   USAGE
     mountScrollWorld(document.getElementById('world'), {
       brand: { name: 'Pearl & Co.', href: '#top' },
       diveScroll: 1.3,   // viewport-heights of scroll per dive clip
       connScroll: 0.9,   // ...per connector clip
       hint: 'scroll to fly in',
       nav: true,         // show the top section nav
       atmosphere: true,  // subtle gradient + drifting particles behind the clips
       sections: [
         { id, label, still, stillMobile, clip, clipMobile, accent,
           scroll: 1.6,   // optional per-section override of diveScroll — more scroll
                          // distance = a slower, longer dwell in this scene
           linger: 0.5,   // optional 0..1 — remaps time so the camera settles mid-scene
                          // (exactly where the copy peaks) and moves quicker at the
                          // edges. 0 = linear (default). Keep ≤ 0.6; 1 = full pause.
           eyebrow, title, body, tags:[…],
           cta:{ primary:{label,href}, secondary:{label,href} } }, // last section only
         …
       ],
       connectors: [clipUrl, …],          // length = sections.length - 1 (nulls allowed)
       connectorsMobile: [clipUrl, …],    // optional lighter connectors for phones (same length)

   MOBILE (the clipMobile/connectorsMobile variants are the opt-in mobile version;
   the rest of the phone handling below is always on)
     The engine is phone-aware out of the box: on a coarse-pointer / ≤860px viewport it
       - loads `clipMobile` / `connectorsMobile` when provided (encode these smaller +
         tighter-GOP — seek cost on a phone decoder is dominated by frames-from-keyframe,
         so a 720p, -g 4 file scrubs far smoother than the 1080p desktop master; see
         pipeline.md). Falls back to the desktop `clip` if no mobile variant is given.
       - uses `stillMobile` as the scene poster when provided (pair it with native 9:16
         clipMobile renders so the poster matches the portrait video's first frame instead
         of flashing from a landscape crop). Chosen once at mount; a desktop resize into
         phone width keeps the desktop poster (clips still switch via isMobile()).
       - coalesces seeks (never issues a new currentTime while the decoder is still
         `seeking`) so fast flicks can't pile up and freeze the video.
       - keeps the still as a live poster until the clip actually paints its first frame,
         and primes each video (muted play→pause) on first touch — this is what stops iOS
         from showing a blank scene before the first seek.
       - drops the drifting particles and ignores URL-bar-only resizes (no scroll jump).
     Nothing here is required — a config with only `clip`/`connectors` still works on
     phones; the mobile variants just make it lighter and smoother.

   THEME (CSS custom properties; set on the container or :root to override)
     --sw-bg         page background (match your scene bg for seamless posters)
     --sw-ink        primary text
     --sw-ink-soft   secondary text
     --sw-accent     default accent (each section overrides via its `accent`)
     --sw-font-display / --sw-font-body

   REQUIREMENTS ON YOUR ASSETS
     - clips encoded native-res, crf~20, -g 8, +faststart, no audio (see pipeline.md)
     - connectors' endpoints are the neighbouring dives' ACTUAL frames (see SKILL Step 5)
     - (optional) mobile variants at ~720p, -g 4 for smoother phone scrubbing
   The engine loads each clip as a Blob (always seekable) and scrubs currentTime; it does
   NOT depend on HTTP byte-range support.
   ========================================================================== */

function mountScrollWorld(container, config) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Phone detection. `coarse` is captured once (input type doesn't change mid-session);
  // the ≤860px query is read live via isMobile() so a desktop resize/DevTools toggle
  // switches sources and seek behaviour without a reload.
  const coarse = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  const smallMQ = window.matchMedia('(max-width: 860px)');
  const isMobile = () => coarse || smallMQ.matches;
  const SECTIONS = config.sections || [];
  const CONNECTORS = config.connectors || [];
  const CONNECTORS_M = config.connectorsMobile || [];
  const DIVE_W = config.diveScroll || 1.3;
  const CONN_W = config.connScroll || 0.9;
  const CROSSFADE = (config.crossfade != null) ? config.crossfade : 0.12;  // seam dissolve width (vh)
  const N = SECTIONS.length;
  if (!N) return;

  injectCSS();
  container.classList.add('sw-root');

  // ---- build the interleaved segment chain: dive0, conn0, dive1, … diveN-1 ----
  const SEGMENTS = [];
  SECTIONS.forEach((s, i) => {
    const dive = { kind: 'dive', si: i, clip: s.clip, clipM: s.clipMobile, still: s.still, stillM: s.stillMobile,
                   accent: s.accent, w: s.scroll || DIVE_W, linger: s.linger || 0 };
    SEGMENTS.push(dive);
    s._seg = dive;
    // A connector is optional: if connectors[i] is falsy, the two dives simply
    // crossfade directly (no fly-over). Lets a page complete even when a
    // connector can't be generated (e.g. a content-filter false-positive).
    if (i < N - 1 && CONNECTORS[i]) {
      SEGMENTS.push({ kind: 'conn', si: i, clip: CONNECTORS[i], clipM: CONNECTORS_M[i],
                      still: SECTIONS[i + 1].still, stillM: SECTIONS[i + 1].stillMobile,
                      accent: SECTIONS[i + 1].accent, w: CONN_W });
    }
  });
  const NSEG = SEGMENTS.length;

  // ---- DOM ----
  const sky = el('div', 'sw-sky');
  if (config.atmosphere !== false) {
    sky.appendChild(el('div', 'sw-sky__grad'));
    sky.appendChild(el('div', 'sw-sky__glow'));
  }
  const particles = el('div', 'sw-particles'); sky.appendChild(particles);

  const scrollbar = el('div', 'sw-scrollbar');
  const scrollbarFill = el('span'); scrollbar.appendChild(scrollbarFill);

  const topbar = el('div', 'sw-topbar');
  if (config.brand) {
    const brand = el('a', 'sw-brand'); brand.href = (config.brand.href || '#');
    brand.appendChild(el('span', 'sw-brand__mark'));
    const nm = el('span', 'sw-brand__name'); nm.textContent = config.brand.name || ''; brand.appendChild(nm);
    topbar.appendChild(brand);
  }
  const topright = el('div', 'sw-topright');
  const nav = el('nav', 'sw-nav'); if (config.nav !== false) topright.appendChild(nav);
  if (config.cta && config.cta.label) {
    const c = el('a', 'sw-topcta'); c.href = config.cta.href || '#'; c.textContent = config.cta.label;
    topright.appendChild(c);
  }
  topbar.appendChild(topright);

  const stage = el('div', 'sw-stage');
  const copylayer = el('div', 'sw-copylayer');
  const route = el('div', 'sw-route');
  const hint = el('div', 'sw-hint');
  const hintText = el('span'); hintText.textContent = config.hint || 'scroll'; hint.appendChild(hintText);
  hint.appendChild(el('i'));
  const track = el('div', 'sw-track');

  [sky, scrollbar, topbar, stage, copylayer, route, hint, track].forEach(n => container.appendChild(n));

  // ---- ambient audio ------------------------------------------------------
  // Sections may carry `audio`. Beds loop continuously and cross-fade by scroll
  // position — the audio is NOT scrubbed. Scrubbing a sound track the way the video
  // is scrubbed produces garbage; what sells the space is a bed playing forward at
  // its own pace while its LEVEL follows where the visitor is.
  //
  // Off by default behind a toggle: browsers refuse to start audio without a real
  // user gesture (scrolling does not count), and unannounced sound is hostile anyway.
  const BEDS = SECTIONS.map(s => s.audio).filter(Boolean).length ? SECTIONS.map(s => {
    if (!s.audio) return null;
    const a = new Audio(); a.src = s.audio; a.loop = true; a.preload = 'none';
    a.volume = 0;
    // Kept in the DOM (hidden) rather than as detached objects: browsers treat
    // document-attached media more predictably for preload and background-tab
    // suspension, and it makes the beds inspectable when debugging the mix.
    a.className = 'sw-bed'; a.setAttribute('aria-hidden', 'true');
    container.appendChild(a);
    return a;
  }) : null;
  const controls = el('div', 'sw-controls');
  let audioOn = false;
  // Last continuous section position, kept so enabling sound while the page is
  // stationary can mix immediately instead of staying silent until the next scroll.
  let lastPos = 0;
  const MASTER = (config.audioVolume != null) ? config.audioVolume : 0.55;
  let sndBtn = null;
  if (BEDS) {
    sndBtn = el('button', 'sw-snd');
    sndBtn.type = 'button';
    sndBtn.setAttribute('aria-pressed', 'false');
    sndBtn.setAttribute('aria-label', 'Play ambient sound');
    sndBtn.innerHTML = '<i><u></u></i><span>SOUND</span>';
    sndBtn.addEventListener('click', () => {
      audioOn = !audioOn;
      sndBtn.classList.toggle('is-on', audioOn);
      sndBtn.setAttribute('aria-pressed', String(audioOn));
      sndBtn.setAttribute('aria-label', audioOn ? 'Mute ambient sound' : 'Play ambient sound');
      BEDS.forEach(a => {
        if (!a) return;
        if (audioOn) { a.preload = 'auto'; a.play().catch(() => {}); }
        else { a.pause(); a.volume = 0; }
      });
      if (audioOn) mixAudio(lastPos);
    });
    controls.appendChild(sndBtn);
  }

  copylayer.addEventListener('click', e => {
    const a = e.target.closest('[data-sw-to]');
    if (!a) return;
    const i = parseInt(a.getAttribute('data-sw-to'), 10);
    if (!isNaN(i) && i >= 0 && i < N) { e.preventDefault(); jumpTo(i); }
  });

  // ---- auto-scroll --------------------------------------------------------
  // Drives the journey hands-free. rAF with a real delta rather than a fixed step per
  // frame, so the pace is the same on a 60 Hz and a 144 Hz display, and a background
  // tab that stalls rAF doesn't lurch forward on return (dt is clamped).
  //
  // Position is accumulated as a float and written with scrollTo: incrementing
  // window.scrollY directly loses the sub-pixel remainder every frame, which at this
  // speed visibly drags behind.
  const AUTO_VH_S = config.autoScrollSpeed || 0.17;   // viewport-heights per second
  let autoOn = false, autoRAF = null, autoPrev = 0, autoPos = 0;

  const autoBtn = el('button', 'sw-auto');
  autoBtn.type = 'button';
  autoBtn.setAttribute('aria-pressed', 'false');
  autoBtn.setAttribute('aria-label', 'Play the journey automatically');
  autoBtn.innerHTML = '<i></i><span>AUTO</span>';

  function autoStop() {
    if (!autoOn) return;
    autoOn = false;
    if (autoRAF) cancelAnimationFrame(autoRAF);
    autoRAF = null; autoPrev = 0;
    autoBtn.classList.remove('is-on');
    autoBtn.setAttribute('aria-pressed', 'false');
    autoBtn.setAttribute('aria-label', 'Play the journey automatically');
  }

  function autoStep(ts) {
    if (!autoOn) return;
    if (!autoPrev) autoPrev = ts;
    const dt = Math.min(120, ts - autoPrev);     // clamp: tab-switch stalls rAF
    autoPrev = ts;
    const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    autoPos += AUTO_VH_S * window.innerHeight * (dt / 1000);
    if (autoPos >= max) { window.scrollTo(0, max); autoStop(); return; }
    window.scrollTo(0, autoPos);
    autoRAF = requestAnimationFrame(autoStep);
  }

  autoBtn.addEventListener('click', () => {
    if (autoOn) { autoStop(); return; }
    const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    // Clicking AUTO at the very end restarts rather than doing nothing.
    autoPos = (window.scrollY >= max - 2) ? 0 : window.scrollY;
    if (autoPos === 0) window.scrollTo(0, 0);
    autoOn = true; autoPrev = 0;
    autoBtn.classList.add('is-on');
    autoBtn.setAttribute('aria-pressed', 'true');
    autoBtn.setAttribute('aria-label', 'Stop automatic playback');
    autoRAF = requestAnimationFrame(autoStep);
  });
  controls.appendChild(autoBtn);

  // Any deliberate scroll input hands control straight back to the visitor — being
  // fought by the page for a moving target is the worst failure mode for this feature.
  ['wheel', 'touchstart', 'pointerdown'].forEach(ev =>
    window.addEventListener(ev, autoStop, { passive: true }));
  window.addEventListener('keydown', e => {
    if (['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(e.key)) autoStop();
  });

  // Level per bed from the scroll position. The ramp is deliberately wide — an
  // abrupt audio change reads far more sharply than an abrupt visual one — so two
  // habitats are almost always audible at once, which is what makes the walk feel
  // continuous rather than chaptered.
  function mixAudio(pos) {
    if (!BEDS || !audioOn) return;
    // `pos` is si + progress-through-section, so it spans 0..N — one past the last
    // index. Two corrections:
    //   - each bed peaks at the MIDDLE of its section (i + 0.5), not its start, so you
    //     hear a habitat while you are in it rather than while arriving at it;
    //   - the value is clamped to the first and last midpoints, so the opening and
    //     closing beds hold full level instead of fading toward sections that do not
    //     exist. Without the upper clamp the last bed decayed to 0.12 by the end and
    //     the journey finished in near silence.
    const p = Math.max(0.5, Math.min(BEDS.length - 0.5, pos));
    for (let i = 0; i < BEDS.length; i++) {
      const a = BEDS[i];
      if (!a) continue;
      const d = Math.abs(p - (i + 0.5));
      const v = d >= 1.2 ? 0 : Math.pow(1 - d / 1.2, 1.6);
      const want = v * MASTER;
      if (Math.abs(a.volume - want) > 0.004) {
        a.volume = Math.max(0, Math.min(1, want));
      }
      if (want <= 0.002 && !a.paused) a.pause();
      else if (want > 0.002 && a.paused) a.play().catch(() => {});
    }
  }

  // segment scenes
  SEGMENTS.forEach(s => {
    const scene = el('div', 'sw-scene'); scene.style.setProperty('--sw-accent', s.accent || '');
    const img = el('img', 'sw-scene__still'); img.alt = ''; img.decoding = 'async'; img.loading = 'lazy';
    const poster = (isMobile() && s.stillM) ? s.stillM : s.still;
    if (poster) img.src = poster;
    scene.appendChild(img); stage.appendChild(scene);
    s.el = scene; s.img = img; s.video = null; s.hasClip = false;
    s.loading = false; s.ready = false; s.cur = 0; s.target = 0; s.visible = false;
  });

  // per-section copy / route / nav
  const copies = [], dots = [];
  SECTIONS.forEach((s, i) => {
    const c = el('article', 'sw-copy'); c.style.setProperty('--sw-accent', s.accent || '');
    if (s.place) c.classList.add('sw-copy--' + s.place);
    c.innerHTML =
      `<span class="sw-copy__num">${pad(i + 1)} / ${pad(N)}</span>` +
      (s.eyebrow ? `<span class="sw-copy__eyebrow">${esc(s.eyebrow)}</span>` : '') +
      (s.title ? `<h2 class="sw-copy__title">${esc(s.title)}</h2>` : '') +
      (s.body ? `<p class="sw-copy__body">${esc(s.body)}</p>` : '') +
      (s.tags && s.tags.length ? `<ul class="sw-copy__tags">${s.tags.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : '') +
      (s.cta ? `<div class="sw-copy__cta">${ctaBtns(s.cta)}</div>` : '');
    copylayer.appendChild(c); copies.push(c);

    const dot = el('button', 'sw-route__dot'); dot.style.setProperty('--sw-accent', s.accent || '');
    dot.innerHTML = `<span class="sw-route__label">${esc(s.label || '')}</span><i></i>`;
    dot.addEventListener('click', () => jumpTo(i)); route.appendChild(dot); dots.push(dot);

    if (config.nav !== false && !config.navItems) {
      const b = el('button', 'sw-nav__item'); b.textContent = s.label || '';
      b.addEventListener('click', () => jumpTo(i)); nav.appendChild(b);
    }
  });

  // Optional editorial nav: a fixed item list that doesn't have to mirror the
  // sections. `to` jumps to a section index (and takes the active highlight);
  // `href` is an ordinary link. Items with neither are inert labels.
  const navToSection = [];
  if (config.nav !== false && config.navItems) {
    config.navItems.forEach(item => {
      const b = el(item.href ? 'a' : 'button', 'sw-nav__item');
      b.textContent = item.label || '';
      if (item.href) b.href = item.href;
      const target = (typeof item.to === 'number') ? item.to : -1;
      navToSection.push(target);
      if (target >= 0) b.addEventListener('click', e => { e.preventDefault(); jumpTo(target); });
      nav.appendChild(b);
    });
  }

  // Appended last so the controls always sit AFTER the links, whichever nav branch ran.
  (config.nav !== false ? nav : topright).appendChild(controls);

  // ---- math ----
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const smooth = x => { x = clamp(x); return x * x * (3 - 2 * x); };
  // Per-section dwell: monotone remap of scroll→time so the camera settles mid-scene
  // (where the copy peaks) and moves quicker near the seams. L=0 linear, L=1 full
  // mid-scene pause. f(0)=0, f(1)=1 always, so seam frames are untouched.
  const lingerEase = (x, L) => { L = clamp(L); const c = x - 0.5; return (1 - L) * x + L * (4 * c * c * c + 0.5); };
  let vh = window.innerHeight, stageX = 0, totalW = 0, activeIndex = -1, ticking = false;
  // End-of-journey dwell: the CTA only appears after the visitor has STAYED at the end
  // for a moment. Without this, merely touching the bottom — or overscrolling past it —
  // flashes the button on and straight off again.
  let endTimer = null, atEnd = false;
  let laidOutW = window.innerWidth;   // width the current layout was computed at (see onResize)

  function layout() {
    vh = window.innerHeight;
    laidOutW = window.innerWidth;
    stageX = window.innerWidth > 860 ? 4 : 0;
    let off = 0;
    SEGMENTS.forEach(s => { s.start = off * vh; off += s.w; s.end = off * vh; });
    totalW = off;
    track.style.height = (totalW * vh + vh) + 'px';   // +1vh so the last flight completes
    read();
  }

  function jumpTo(i) {
    const seg = SECTIONS[i]._seg;
    window.scrollTo({ top: seg.start + (seg.end - seg.start) * 0.5, behavior: reduce ? 'auto' : 'smooth' });
  }

  function loadClip(s) {
    // Under prefers-reduced-motion we never load the clips at all — the stills stay up
    // and simply cross-dissolve as you scroll. No scrubbed video motion, no decode cost.
    if (reduce || s.loading || !s.clip) return;
    s.loading = true;
    // Serve the lighter mobile encode on phones when one was provided.
    const url = (isMobile() && s.clipM) ? s.clipM : s.clip;
    fetch(url).then(r => r.ok ? r.blob() : Promise.reject(new Error('404')))
      .then(blob => {
        const v = document.createElement('video');
        v.className = 'sw-scene__video';
        v.muted = true; v.playsInline = true; v.preload = 'auto';
        v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
        v.src = URL.createObjectURL(blob);
        v.addEventListener('loadedmetadata', () => { s.ready = true; read(); });
        // Reveal the video (hide the still poster) only once a real frame has
        // painted — on iOS a seeked-but-never-played muted video stays blank, so
        // hiding the still on metadata alone would flash an empty scene.
        v.addEventListener('seeked', () => { s.el.classList.add('has-clip'); }, { once: true });
        v.addEventListener('loadeddata', () => { try { v.pause(); } catch (e) {} if (userReady) primeVideo(v); });
        s.el.appendChild(v); s.video = v; s.hasClip = true;
      }).catch(() => { s.loading = false; });
  }

  function read() {
    const y = window.scrollY || window.pageYOffset;
    const fade = CROSSFADE * vh;
    let ci = 0;
    for (let i = 0; i < NSEG; i++) if (y >= SEGMENTS[i].start) ci = i;

    for (let i = 0; i < NSEG; i++) {
      const s = SEGMENTS[i];
      if (y > s.start - 1.6 * vh && y < s.end + 1.6 * vh) loadClip(s);
      const local = clamp((y - s.start) / (s.end - s.start), 0, 1);
      s.target = s.linger ? lingerEase(local, s.linger) : local;
      let outside = 0;
      if (y < s.start) outside = s.start - y; else if (y > s.end) outside = y - s.end;
      const op = smooth(1 - outside / fade);
      s.el.style.opacity = op; s.visible = op > 0.001;
      s.el.style.zIndex = (i === ci) ? '120' : String(100 + Math.round(op * 10));
      if (!s.hasClip || !s.ready) {
        const sc = reduce ? 1 : 1.03 + local * 0.14;
        s.img.style.transform = `translateX(${stageX - 2}vw) scale(${sc.toFixed(3)})`;
      }
    }

    for (let i = 0; i < N; i++) {
      const seg = SECTIONS[i]._seg;
      const pr = clamp((y - seg.start) / (seg.end - seg.start), 0, 1);
      const before = y < seg.start, after = y > seg.end;
      let cop;
      if (i === 0) cop = after ? 0 : smooth(1 - pr / 0.62);            // greets on landing
      else if (i === N - 1) cop = before ? 0 : smooth(pr / 0.4);       // holds CTA at the end
      else cop = (before || after) ? 0 : smooth(1 - Math.abs(pr - 0.5) / 0.5);
      const c = copies[i];
      c.style.opacity = cop;
      c.style.transform = reduce ? 'none' : `translateY(${(0.5 - pr) * 4}vh)`;
      c.style.pointerEvents = cop > 0.5 ? 'auto' : 'none';
    }

    const cur = SEGMENTS[ci];
    const near = clamp(cur.kind === 'dive' ? cur.si
      : (((y - cur.start) / (cur.end - cur.start)) > 0.5 ? cur.si + 1 : cur.si), 0, N - 1);
    if (near !== activeIndex) {
      activeIndex = near;
      dots.forEach((d, k) => d.classList.toggle('is-active', k === near));
      nav.querySelectorAll('.sw-nav__item').forEach((n, k) =>
        n.classList.toggle('is-active', navToSection.length ? navToSection[k] === near : k === near));
      container.style.setProperty('--sw-accent', SECTIONS[near].accent || '');
      // Per-section theme. A journey that runs from morning into night can't keep one
      // chrome palette: dark text on a light scrim is right over a sunlit canopy and
      // illegible over a moonlit one. Sections may carry `theme:{bg,ink,inkSoft}`; the
      // tokens transition via CSS so the chrome eases into night with the footage.
      const th = SECTIONS[near].theme;
      if (th) {
        if (th.bg) container.style.setProperty('--sw-bg', th.bg);
        if (th.ink) container.style.setProperty('--sw-ink', th.ink);
        if (th.inkSoft) container.style.setProperty('--sw-ink-soft', th.inkSoft);
      }
    }
    const progress = clamp(y / (totalW * vh));
    scrollbarFill.style.transform = `scaleX(${progress})`;
    // Marks the end of the journey so the page can reveal a closing call to action.
    // Toggled on the container rather than body so a sibling selector can target it
    // without the engine reaching outside its own mount point.
    // Arming is delayed; disarming is immediate — scrolling back up should take the
    // button away at once, not after another wait.
    const wantEnd = progress >= (config.endAt || 0.9);
    if (wantEnd) {
      if (!atEnd && endTimer === null) {
        endTimer = setTimeout(() => {
          endTimer = null; atEnd = true; container.classList.add('sw-end');
        }, config.endDelay != null ? config.endDelay : 1000);
      }
    } else {
      if (endTimer !== null) { clearTimeout(endTimer); endTimer = null; }
      if (atEnd) { atEnd = false; container.classList.remove('sw-end'); }
    }
    hint.style.opacity = clamp(1 - y / (0.5 * vh));
    if (particles) particles.style.transform = `translate3d(0, ${-y * 0.05}px, 0)`;
    // Continuous section position (2.4 == 40% of the way from section 2 to 3), so the
    // beds cross-fade smoothly instead of stepping on the active-section change.
    if (BEDS) {
      const seg = SEGMENTS[ci];
      const f = (y - seg.start) / Math.max(1, seg.end - seg.start);
      lastPos = seg.si + clamp(f);
      mixAudio(lastPos);
    }
    ticking = false;
  }

  function raf() {
    // Seek threshold, in seconds. A seek smaller than roughly half a frame cannot
    // change the picture, so issuing one is pure decode work — and at low frame rates
    // a fixed 0.008s threshold fires several useless seeks per displayed frame, which
    // is what makes scrubbing feel like it is hanging. Derive it from the clip's own
    // frame duration where we can, and keep the coarser phone floor.
    const FPS_ASSUMED = config.fps || 24;
    const half = 0.5 / FPS_ASSUMED;
    const eps = isMobile() ? Math.max(0.02, half) : half;
    for (let i = 0; i < NSEG; i++) {
      const s = SEGMENTS[i];
      if (!s.hasClip || !s.ready || !s.video) continue;
      // Never queue a seek while the decoder is still resolving the last one.
      // On phones a fast flick would otherwise pile up seeks and freeze the clip;
      // cur keeps lerping, so we snap to the latest target the moment it's free.
      if (s.video.seeking) continue;
      if (!s.visible && Math.abs(s.cur - s.target) < 0.002) continue;
      s.cur += (s.target - s.cur) * (reduce ? 1 : 0.18);
      const dur = s.video.duration || 1;
      const t = clamp(s.cur, 0, 0.999) * dur;
      if (Math.abs(s.video.currentTime - t) > eps) { try { s.video.currentTime = t; } catch (e) {} }
    }
    requestAnimationFrame(raf);
  }

  // iOS needs a user gesture before a muted video will decode/paint reliably. On the
  // first touch we prime every loaded clip (muted play→pause) so the first seek is
  // instant instead of showing a blank frame. `userReady` also makes freshly-loaded
  // clips prime themselves (see loadClip).
  let userReady = false;
  function primeVideo(v) {
    if (!isMobile() || !v) return;
    try { const p = v.play(); if (p && p.then) p.then(() => { try { v.pause(); } catch (e) {} }).catch(() => {}); }
    catch (e) {}
  }
  function onFirstGesture() {
    if (userReady) return;
    userReady = true;
    SEGMENTS.forEach(s => primeVideo(s.video));
  }
  window.addEventListener('pointerdown', onFirstGesture, { once: true, passive: true });
  window.addEventListener('touchstart', onFirstGesture, { once: true, passive: true });

  // Particles are a per-frame cost we can't afford alongside video scrubbing on a phone.
  seedParticles(particles, reduce || coarse);
  window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(read); } }, { passive: true });
  // Mobile browsers fire `resize` every time the URL bar slides in/out. Re-running
  // layout() there rebuilds the track height and yanks the scroll position, so on
  // touch we ignore height-only changes and only relayout when the width actually
  // changes (rotation still comes through orientationchange). layout() records the
  // width it laid out at.
  function onResize() {
    if (coarse && window.innerWidth === laidOutW) return;
    layout();
  }
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', layout);
  window.addEventListener('load', layout);
  layout();
  requestAnimationFrame(raf);

  // ---- helpers ----
  function el(tag, cls) { const n = document.createElement(tag); if (cls) n.className = cls; return n; }
  function pad(n) { return String(n).padStart(2, '0'); }
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function ctaBtns(cta) {
    // `buttons: [{label, href, primary?}]` renders any number of actions; the
    // primary/secondary pair stays supported so existing configs keep working.
    if (Array.isArray(cta.buttons)) {
      return cta.buttons.map((b, i) => {
        const isPrimary = (b.primary != null) ? b.primary : i === 0;
        const jump = (typeof b.to === 'number') ? ` data-sw-to="${b.to}"` : '';
        return `<a class="sw-btn ${isPrimary ? 'sw-btn--primary' : 'sw-btn--ghost'}"` +
               `${jump} href="${esc(b.href || '#')}">${esc(b.label)}</a>`;
      }).join('');
    }
    let h = '';
    if (cta.primary) h += `<a class="sw-btn sw-btn--primary" href="${esc(cta.primary.href || '#')}">${esc(cta.primary.label)}</a>`;
    if (cta.secondary) h += `<a class="sw-btn sw-btn--ghost" href="${esc(cta.secondary.href || '#')}">${esc(cta.secondary.label)}</a>`;
    return h;
  }
}

function seedParticles(host, reduce) {
  if (!host || reduce) return;
  const kinds = ['dot', 'dot', 'ring'];
  const seeds = [7, 23, 41, 58, 71, 88, 12, 34, 52, 66, 83, 95, 18, 29, 47, 63, 77, 91, 5, 38, 55, 69, 82, 97];
  for (let k = 0; k < 20; k++) {
    const s = document.createElement('span');
    s.className = 'sw-pt sw-pt--' + kinds[k % kinds.length];
    s.style.left = seeds[k % seeds.length] + 'vw';
    s.style.top = ((seeds[(k * 3) % seeds.length] * 1.3) % 100) + 'vh';
    s.style.setProperty('--sw-sc', (0.5 + ((seeds[(k * 5) % seeds.length] % 60) / 60) * 1.1).toFixed(2));
    const dur = 14 + (seeds[(k * 7) % seeds.length] % 22);
    s.style.animationDuration = dur + 's';
    s.style.animationDelay = (-(seeds[(k * 2) % seeds.length] % dur)) + 's';
    host.appendChild(s);
  }
}

function injectCSS() {
  if (document.getElementById('sw-css')) return;
  const css = `
  .sw-root{--sw-ink:#241d2b;--sw-ink-soft:#6a6072;--sw-accent:#8a7bb5;
    --sw-font-display:ui-rounded,"SF Pro Rounded","Segoe UI",system-ui,sans-serif;
    --sw-font-body:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;
    color:var(--sw-ink);font-family:var(--sw-font-body);}
  html,body{margin:0;background:var(--sw-bg,#F5EDE0);overflow-x:hidden;}
  .sw-sky{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none;}
  .sw-sky__grad{position:absolute;inset:-10%;background:linear-gradient(178deg,color-mix(in srgb,var(--sw-accent) 12%,var(--sw-bg)) 0%,var(--sw-bg) 55%,color-mix(in srgb,var(--sw-accent) 6%,var(--sw-bg)) 100%);}
  .sw-sky__glow{position:absolute;inset:0;background:radial-gradient(60% 42% at 74% 16%,color-mix(in srgb,var(--sw-accent) 22%,transparent),transparent 70%),radial-gradient(46% 34% at 50% 50%,color-mix(in srgb,#fff 45%,transparent),transparent 70%);}
  .sw-particles{position:absolute;inset:-6% -2%;will-change:transform;}
  .sw-pt{position:absolute;width:13px;height:13px;transform:scale(var(--sw-sc,1));opacity:0;animation:sw-drift linear infinite;}
  .sw-pt::before{content:"";position:absolute;inset:0;border-radius:50%;}
  .sw-pt--dot::before{background:radial-gradient(circle at 34% 30%,color-mix(in srgb,var(--sw-accent) 60%,#000),#000 82%);}
  .sw-pt--ring::before{background:transparent;border:2px solid color-mix(in srgb,var(--sw-accent) 55%,transparent);}
  @keyframes sw-drift{0%{opacity:0;transform:scale(var(--sw-sc)) translate(0,12vh) rotate(0)}12%{opacity:.5}88%{opacity:.45}100%{opacity:0;transform:scale(var(--sw-sc)) translate(4vw,-22vh) rotate(210deg)}}
  /* Sound and auto live INSIDE the nav pill with the links. .sw-topright still groups
     the pill (and any top CTA) so the topbar's space-between keeps brand left. */
  .sw-topright{display:flex;align-items:center;gap:10px;}
  .sw-controls{display:flex;align-items:center;gap:2px;}
  /* Hairline divider so the two controls read as a distinct group from the links
     without needing a separate container. */
  .sw-nav .sw-controls{position:relative;margin-left:6px;padding-left:8px;}
  .sw-nav .sw-controls::before{content:"";position:absolute;left:0;top:50%;
    transform:translateY(-50%);width:1px;height:15px;
    background:color-mix(in srgb,var(--sw-ink) 18%,transparent);}
  .sw-snd,.sw-auto{display:flex;align-items:center;gap:7px;padding:7px 13px 7px 11px;
    border-radius:999px;cursor:pointer;font:inherit;font-size:.64rem;letter-spacing:.16em;
    color:var(--sw-ink-soft);background:color-mix(in srgb,var(--sw-bg) 62%,transparent);
    backdrop-filter:blur(10px);border:1px solid color-mix(in srgb,var(--sw-ink) 12%,transparent);
    transition:color .25s,background .25s;}
  /* Nested in the nav pill: drop the chrome so they sit flush with the links. */
  .sw-nav .sw-snd,.sw-nav .sw-auto{background:transparent;border:0;backdrop-filter:none;}
  .sw-nav .sw-snd.is-on,.sw-nav .sw-auto.is-on{color:#fff;background:var(--sw-accent);}
  .sw-snd:hover,.sw-auto:hover{color:var(--sw-ink);}
  .sw-snd.is-on,.sw-auto.is-on{color:var(--sw-ink);
    border-color:color-mix(in srgb,var(--sw-accent) 45%,transparent);}
  /* The nav pill hides under 860px; without this the controls vanish with it. */
  @media (max-width:860px){
    .sw-nav{display:flex !important;padding:4px;}
    .sw-nav__item{display:none;}
    .sw-nav .sw-controls{margin-left:0;padding-left:0;}
    .sw-nav .sw-controls::before{display:none;}}
  /* Three bars: still when muted, animating when sound is on — state readable at a
     glance without a crossed-out icon. */
  .sw-snd i{position:relative;width:13px;height:12px;flex:0 0 13px;}
  .sw-snd i::before,.sw-snd i::after,.sw-snd i>u{content:"";position:absolute;bottom:0;width:3px;
    background:currentColor;border-radius:2px;height:4px;transition:height .3s;}
  .sw-snd i::before{left:0;} .sw-snd i>u{left:5px;} .sw-snd i::after{left:10px;}
  .sw-snd.is-on i::before{animation:sw-eq 1.1s ease-in-out infinite;}
  .sw-snd.is-on i>u{animation:sw-eq 1.1s ease-in-out .18s infinite;height:8px;}
  .sw-snd.is-on i::after{animation:sw-eq 1.1s ease-in-out .36s infinite;}
  @keyframes sw-eq{0%,100%{height:3px;}50%{height:12px;}}
  /* Play triangle that becomes a pause bar while running. */
  .sw-auto i{position:relative;width:11px;height:12px;flex:0 0 11px;}
  .sw-auto i::before{content:"";position:absolute;left:1px;top:1px;width:0;height:0;
    border-left:9px solid currentColor;border-top:5px solid transparent;
    border-bottom:5px solid transparent;transition:opacity .2s;}
  .sw-auto i::after{content:"";position:absolute;left:1px;top:1px;width:3px;height:10px;
    background:currentColor;box-shadow:5px 0 0 currentColor;opacity:0;transition:opacity .2s;}
  .sw-auto.is-on i::before{opacity:0;} .sw-auto.is-on i::after{opacity:1;}
  @media (prefers-reduced-motion:reduce){
    .sw-snd.is-on i::before,.sw-snd.is-on i>u,.sw-snd.is-on i::after{animation:none;height:8px;}}
  @media (max-width:860px){
    .sw-topright{gap:6px;}
    /* Labels drop on phones; the icons alone carry the two controls. */
    .sw-snd span,.sw-auto span{display:none;}
    .sw-snd,.sw-auto{font-size:.6rem;padding:9px 11px;gap:0;}}
  .sw-bed{display:none;}
  .sw-scrollbar{position:fixed;top:0;left:0;right:0;height:3px;z-index:60;background:color-mix(in srgb,var(--sw-accent) 14%,transparent);}
  .sw-scrollbar span{display:block;height:100%;width:100%;transform-origin:0 50%;transform:scaleX(0);background:var(--sw-accent);}
  .sw-topbar{position:fixed;top:0;left:0;right:0;z-index:50;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:clamp(14px,2.4vw,26px) clamp(18px,5vw,64px);}
  .sw-brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--sw-ink);}
  .sw-brand__mark{width:24px;height:28px;border-radius:7px 7px 10px 10px;background:linear-gradient(160deg,var(--sw-accent),color-mix(in srgb,var(--sw-accent) 60%,#000));box-shadow:0 6px 14px color-mix(in srgb,var(--sw-accent) 40%,transparent);}
  .sw-brand__name{font-family:var(--sw-font-display);font-weight:700;font-size:1.1rem;}
  .sw-nav{display:flex;gap:4px;padding:5px;background:color-mix(in srgb,#fff 55%,transparent);backdrop-filter:blur(10px);border:1px solid color-mix(in srgb,var(--sw-accent) 16%,transparent);border-radius:999px;}
  .sw-nav__item{font:inherit;font-size:.82rem;color:var(--sw-ink-soft);border:0;background:transparent;cursor:pointer;padding:7px 14px;border-radius:999px;transition:color .25s,background .25s;}
  .sw-nav__item:hover{color:var(--sw-ink);} .sw-nav__item.is-active{color:#fff;background:var(--sw-accent);}
  .sw-topcta{text-decoration:none;font-weight:600;font-size:.9rem;color:#fff;background:var(--sw-ink);padding:10px 20px;border-radius:999px;white-space:nowrap;}
  .sw-stage{position:fixed;inset:0;z-index:10;pointer-events:none;}
  .sw-scene{position:absolute;inset:0;opacity:0;overflow:hidden;will-change:opacity;}
  .sw-scene__video,.sw-scene__still{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center 42%;}
  .sw-scene__still{will-change:transform;} .sw-scene.has-clip .sw-scene__still{opacity:0;} .sw-scene__video{z-index:1;}
  .sw-copylayer{position:fixed;inset:0;z-index:20;pointer-events:none;display:grid;
    padding:clamp(88px,13vh,150px) clamp(18px,5vw,64px) clamp(84px,14vh,132px);}
  /* Every copy block shares one grid cell and is placed with align/justify-self, so a
     section can sit bottom-left, bottom-right, centre — without touching transform. */
  .sw-copy{grid-area:1/1;align-self:center;justify-self:start;width:min(42vw,460px);
    opacity:0;will-change:opacity,transform;}
  .sw-copy--left-top{align-self:start;justify-self:start;}
  .sw-copy--left-bottom{align-self:end;justify-self:start;}
  .sw-copy--right{align-self:center;justify-self:end;text-align:right;}
  .sw-copy--right-top{align-self:start;justify-self:end;text-align:right;}
  .sw-copy--right-bottom{align-self:end;justify-self:end;text-align:right;}
  .sw-copy--center{align-self:center;justify-self:center;text-align:center;}
  .sw-copy--center-bottom{align-self:end;justify-self:center;text-align:center;}
  /* Right/centre variants need their inner flex rows re-anchored too, or the tags and
     buttons stay left while the text moves. */
  .sw-copy--right .sw-copy__tags,.sw-copy--right-top .sw-copy__tags,
  .sw-copy--right-bottom .sw-copy__tags,.sw-copy--right .sw-copy__cta,
  .sw-copy--right-top .sw-copy__cta,.sw-copy--right-bottom .sw-copy__cta{justify-content:flex-end;}
  .sw-copy--center .sw-copy__tags,.sw-copy--center-bottom .sw-copy__tags,
  .sw-copy--center .sw-copy__cta,.sw-copy--center-bottom .sw-copy__cta{justify-content:center;}
  .sw-copy--right .sw-copy__body,.sw-copy--right-top .sw-copy__body,
  .sw-copy--right-bottom .sw-copy__body{margin-left:auto;}
  .sw-copy--center .sw-copy__body,.sw-copy--center-bottom .sw-copy__body{margin-left:auto;margin-right:auto;}
  .sw-copy__num{font-family:ui-monospace,Menlo,monospace;font-size:.74rem;letter-spacing:.12em;color:var(--sw-ink-soft);}
  .sw-copy__eyebrow{display:block;margin-top:18px;font-family:var(--sw-font-display);font-weight:700;font-size:.8rem;letter-spacing:.16em;text-transform:uppercase;color:var(--sw-accent);}
  .sw-copy__title{font-family:var(--sw-font-display);font-weight:700;color:var(--sw-ink);font-size:clamp(2rem,4.4vw,3.5rem);line-height:1.03;margin:12px 0 0;letter-spacing:-.01em;text-shadow:0 2px 20px color-mix(in srgb,var(--sw-bg) 70%,transparent);}
  .sw-copy__body{margin-top:18px;font-size:clamp(1rem,1.25vw,1.14rem);line-height:1.55;color:color-mix(in srgb,var(--sw-ink) 78%,var(--sw-ink-soft));max-width:40ch;text-shadow:0 1px 12px color-mix(in srgb,var(--sw-bg) 90%,transparent);}
  .sw-copy__tags{list-style:none;display:flex;flex-wrap:wrap;gap:8px;margin:24px 0 0;padding:0;}
  .sw-copy__tags li{font-size:.82rem;font-weight:600;color:color-mix(in srgb,var(--sw-accent) 70%,#000);padding:7px 14px;border-radius:999px;background:color-mix(in srgb,var(--sw-accent) 14%,#fff);border:1px solid color-mix(in srgb,var(--sw-accent) 30%,transparent);}
  .sw-copy__cta{display:flex;flex-wrap:wrap;gap:12px;margin-top:28px;pointer-events:auto;}
  .sw-btn{text-decoration:none;font-weight:600;font-size:.95rem;padding:13px 24px;border-radius:999px;transition:transform .2s;}
  .sw-btn--primary{color:#fff;background:var(--sw-ink);} .sw-btn--primary:hover{transform:translateY(-2px);}
  .sw-btn--ghost{color:var(--sw-ink);border:1.5px solid color-mix(in srgb,var(--sw-ink) 25%,transparent);} .sw-btn--ghost:hover{transform:translateY(-2px);}
  .sw-route{position:fixed;right:clamp(14px,2.4vw,30px);top:50%;z-index:40;transform:translateY(-50%);display:flex;flex-direction:column;gap:22px;padding:18px 10px;}
  .sw-route::before{content:"";position:absolute;left:50%;top:22px;bottom:22px;width:2px;transform:translateX(-50%);background:var(--sw-accent);opacity:.28;}
  .sw-route__dot{position:relative;border:0;background:transparent;cursor:pointer;width:14px;height:14px;display:grid;place-items:center;}
  .sw-route__dot i{width:9px;height:9px;border-radius:50%;background:color-mix(in srgb,var(--sw-accent) 40%,transparent);transition:transform .3s,background .3s,box-shadow .3s;}
  .sw-route__dot:hover i{transform:scale(1.25);background:var(--sw-accent);}
  .sw-route__dot.is-active i{background:var(--sw-accent);transform:scale(1.4);box-shadow:0 0 0 5px color-mix(in srgb,var(--sw-accent) 22%,transparent);}
  .sw-route__label{position:absolute;right:24px;top:50%;transform:translateY(-50%) translateX(6px);white-space:nowrap;font-size:.78rem;font-weight:600;color:var(--sw-ink);background:color-mix(in srgb,#fff 85%,transparent);backdrop-filter:blur(6px);padding:5px 11px;border-radius:999px;opacity:0;pointer-events:none;transition:opacity .25s,transform .25s;border:1px solid color-mix(in srgb,var(--sw-accent) 14%,transparent);}
  .sw-route__dot:hover .sw-route__label,.sw-route__dot.is-active .sw-route__label{opacity:1;transform:translateY(-50%) translateX(0);}
  .sw-hint{position:fixed;left:50%;bottom:26px;z-index:30;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:10px;font-size:.76rem;letter-spacing:.14em;text-transform:uppercase;color:var(--sw-ink-soft);transition:opacity .3s;}
  .sw-hint i{width:22px;height:34px;border-radius:12px;border:2px solid color-mix(in srgb,var(--sw-ink) 28%,transparent);position:relative;}
  .sw-hint i::after{content:"";position:absolute;left:50%;top:7px;width:4px;height:7px;border-radius:2px;background:var(--sw-accent);transform:translateX(-50%);animation:sw-wheel 1.7s ease-in-out infinite;}
  @keyframes sw-wheel{0%{opacity:0;top:6px}40%{opacity:1}100%{opacity:0;top:17px}}
  .sw-track{position:relative;z-index:1;width:100%;pointer-events:none;}
  @media (max-width:860px){
    .sw-nav{display:none;}
    /* Anchor copy to the bottom, clear of the home indicator / collapsing URL bar.
       dvh + env() are progressive: browsers that lack them keep the vh fallback line. */
    .sw-copylayer{padding:clamp(70px,10vh,110px) clamp(18px,5vw,64px)
      calc(clamp(64px,12dvh,110px) + env(safe-area-inset-bottom));}
    .sw-copy,.sw-copy--left-top,.sw-copy--left-bottom,.sw-copy--right,.sw-copy--right-top,
    .sw-copy--right-bottom,.sw-copy--center,.sw-copy--center-bottom{
      align-self:end;justify-self:stretch;text-align:left;width:auto;max-width:560px;}
    .sw-copy__title{font-size:clamp(1.9rem,7.5vw,2.7rem);}
    .sw-copy__body{max-width:none;font-size:clamp(.98rem,3.6vw,1.1rem);} .sw-scene__video,.sw-scene__still{object-position:center 46%;}
    .sw-hint{bottom:calc(20px + env(safe-area-inset-bottom));}
    .sw-route{gap:16px;right:6px;} .sw-route__label{display:none;}
  }
  /* Portrait phones crop a 16:9 clip hard; keep the framing centred so the focal
     subject (which the camera dives toward) stays in view. */
  @media (max-width:860px) and (orientation:portrait){
    .sw-scene__video,.sw-scene__still{object-position:center 44%;}
  }
  /* Touch: give the route dots a finger-sized hit area without growing the visible dot. */
  @media (hover:none) and (pointer:coarse){
    .sw-route{padding:14px 6px;}
    .sw-route__dot{width:28px;height:28px;}
    .sw-btn{padding:15px 26px;}
  }
  @media (prefers-reduced-motion:reduce){ .sw-hint i::after{animation:none;} .sw-pt{display:none;} }
  `;
  // Wrap in a cascade layer so the page's own theme tokens (unlayered
  // :root / .sw-root { --sw-bg / --sw-ink / --sw-accent … }) always win over
  // these defaults, regardless of injection order. Enables clean dark themes.
  const style = document.createElement('style'); style.id = 'sw-css';
  style.textContent = '@layer sw {\n' + css + '\n}';
  document.head.appendChild(style);
}

// Expose for module + global use.
if (typeof module !== 'undefined' && module.exports) module.exports = { mountScrollWorld };
if (typeof window !== 'undefined') window.mountScrollWorld = mountScrollWorld;
