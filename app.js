(function () {
  'use strict';

  var standalone = !!(window.GALLERY_CONFIG && window.GALLERY_CONFIG.standalone);
  var defaults = { intervalSeconds: 300, clock: true, frame: 'walnut', mat: 'linen', brightness: 85, nightDim: true, showCaption: true };
  var settings = copy(defaults);
  var catalog = [];
  var localCatalog = [];
  var currentId = '';
  var paused = false;
  var connected = false;
  var serverUrl = '';
  var panel = '';
  var controlsOpen = false;
  var filter = 'all';
  var pending = 0;
  var postQueue = [];
  var polling = false;
  var hideTimer = 0;
  var toastTimer = 0;
  var lastAdvance = Date.now();
  var imageRequest = 0;
  var lastImageUrl = '';
  var lastRenderedId = '';
  var tvConnection = { paired: false, apps: [] };
  var launchingId = '';
  var lastDockFocus = null;
  var clockShift = false;
  var storageKey = standalone ? 'wall-gallery-hosted-v1' : 'wall-gallery-v1';
  var gallery = document.getElementById('gallery');
  var image = document.getElementById('artwork');

  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function byId(id) { return document.getElementById(id); }
  function text(id, value) { byId(id).textContent = value == null ? '' : String(value); }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value))); }
  function normalizeSettings(value) {
    var result = copy(defaults);
    if (!value || typeof value !== 'object') return result;
    if (['walnut', 'ivory', 'none'].indexOf(value.frame) !== -1) result.frame = value.frame;
    if (['linen', 'dark', 'none'].indexOf(value.mat) !== -1) result.mat = value.mat;
    ['clock', 'nightDim', 'showCaption'].forEach(function (key) { if (typeof value[key] === 'boolean') result[key] = value[key]; });
    if (isFinite(value.brightness)) result.brightness = clamp(value.brightness, 25, 100);
    if (isFinite(value.intervalSeconds)) result.intervalSeconds = clamp(value.intervalSeconds, 15, 86400);
    return result;
  }
  function cleanServerUrl(value) {
    if (!value) return '';
    try {
      var url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      if (url.username || url.password) return '';
      return url.origin;
    } catch (error) { return ''; }
  }
  function saveLocal() {
    try { localStorage.setItem(storageKey, JSON.stringify({ settings: settings, currentId: currentId, paused: paused, serverUrl: serverUrl })); } catch (error) { /* TV storage may be unavailable. */ }
  }
  function loadLocal() {
    try {
      var saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
      settings = normalizeSettings(saved.settings);
      if (typeof saved.currentId === 'string') currentId = saved.currentId;
      paused = saved.paused === true;
      serverUrl = cleanServerUrl(saved.serverUrl);
    } catch (error) { settings = copy(defaults); }
    if (standalone) { serverUrl = ''; return; }
    if (!serverUrl && window.GALLERY_CONFIG) serverUrl = cleanServerUrl(window.GALLERY_CONFIG.companionUrl);
    if (!serverUrl && (location.protocol === 'http:' || location.protocol === 'https:')) serverUrl = location.origin;
  }
  function request(url, method, payload, callback, timeoutMs) {
    var xhr = new XMLHttpRequest();
    var complete = false;
    function done(error, response) { if (!complete) { complete = true; callback(error, response); } }
    xhr.open(method, url, true);
    xhr.timeout = timeoutMs || 6500;
    if (payload !== null) xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = function () {
      if ((xhr.status >= 200 && xhr.status < 300) || (xhr.status === 0 && xhr.responseText && url.indexOf('http') !== 0)) {
        try { done(null, xhr.responseText ? JSON.parse(xhr.responseText) : {}); } catch (error) { done(new Error('The companion returned an invalid response.')); }
      } else {
        var message = 'The companion is unavailable.';
        try { var failure = JSON.parse(xhr.responseText); if (failure.error) message = failure.error; } catch (error) { /* Use the connection message. */ }
        done(new Error(message));
      }
    };
    xhr.onerror = function () { done(new Error('The companion is unavailable.')); };
    xhr.ontimeout = function () { done(new Error('The companion timed out.')); };
    try { xhr.send(payload === null ? null : JSON.stringify(payload)); } catch (error) { done(error); }
  }
  function validCatalog(items, remote) {
    if (!Array.isArray(items)) return [];
    return items.filter(function (item) { return item && typeof item.id === 'string' && typeof item.image === 'string' && item.image.length > 0; }).map(function (item) {
      var artwork = copy(item);
      artwork.kind = artwork.kind === 'photo' ? 'photo' : 'art';
      if (remote && artwork.image.charAt(0) === '/') artwork.image = serverUrl + artwork.image;
      else if (remote && artwork.image.indexOf('://') === -1) artwork.image = serverUrl + '/tv/' + artwork.image.replace(/^\.\//, '');
      return artwork;
    });
  }
  function currentArtwork() {
    for (var i = 0; i < catalog.length; i += 1) if (catalog[i].id === currentId) return catalog[i];
    return catalog.length ? catalog[0] : null;
  }
  function showArtwork(force) {
    var artwork = currentArtwork();
    if (!artwork) {
      byId('empty-state').hidden = false;
      text('artwork-title', 'Your collection is waiting');
      text('artwork-artist', 'Wall Gallery');
      text('artwork-date', 'Connect your phone to add photos.');
      return;
    }
    currentId = artwork.id;
    text('artwork-title', artwork.title || 'Untitled');
    text('artwork-artist', artwork.artist || (artwork.kind === 'photo' ? 'Your photographs' : 'The collection'));
    var details = [];
    if (artwork.date) details.push(artwork.date);
    if (artwork.source) details.push(artwork.source);
    if (artwork.license) details.push(artwork.license);
    text('artwork-date', details.join(' · '));
    if (!force && lastImageUrl === artwork.image) return;
    var thisRequest = ++imageRequest;
    var preload = new Image();
    image.classList.add('is-changing');
    preload.onload = function () {
      if (thisRequest !== imageRequest) return;
      image.src = artwork.image;
      image.alt = (artwork.title || 'Artwork') + (artwork.artist ? ', by ' + artwork.artist : '');
      image.classList.add('is-ready');
      image.classList.remove('is-changing');
      lastImageUrl = artwork.image;
      lastRenderedId = artwork.id;
      byId('empty-state').hidden = true;
      window.requestAnimationFrame(confirmDisplay);
    };
    preload.onerror = function () {
      if (thisRequest !== imageRequest) return;
      image.classList.remove('is-changing');
      if (!lastImageUrl) {
        byId('empty-state').hidden = false;
        byId('empty-state').querySelector('p').textContent = 'This image is unavailable. Choose another work with the remote.';
      }
      showToast('This image could not load. Try another artwork.');
    };
    preload.src = artwork.image;
    saveLocal();
    if (panel === 'collection') markCurrentCard();
  }
  function intervalLabel(seconds) {
    if (seconds < 60) return seconds + ' seconds';
    if (seconds === 3600) return '1 hour';
    if (seconds >= 3600) return Math.round(seconds / 3600 * 10) / 10 + ' hours';
    return Math.round(seconds / 60) + ' minutes';
  }
  function applyAppearance() {
    gallery.setAttribute('data-frame', settings.frame);
    gallery.setAttribute('data-mat', settings.mat);
    image.style.filter = 'brightness(' + settings.brightness / 100 + ')';
    byId('clock').hidden = !settings.clock;
    byId('caption').classList.toggle('is-disabled', !settings.showCaption);
    text('value-frame', { walnut: 'Walnut', ivory: 'Ivory', none: 'No frame' }[settings.frame]);
    text('value-mat', { linen: 'Linen', dark: 'Charcoal', none: 'No mount' }[settings.mat]);
    ['clock', 'nightDim', 'showCaption'].forEach(function (key) { text('value-' + key, settings[key] ? 'On' : 'Off'); });
    text('value-intervalSeconds', intervalLabel(settings.intervalSeconds));
    text('value-brightness', settings.brightness + '%');
    updateClock();
  }
  function updateClock() {
    var now = new Date();
    var hours = now.getHours();
    var minutes = now.getMinutes();
    var time = (hours % 12 || 12) + ':' + (minutes < 10 ? '0' : '') + minutes;
    text('clock-time', time);
    byId('clock-time').setAttribute('datetime', now.toISOString());
    try { text('clock-date', now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })); }
    catch (error) { text('clock-date', now.toDateString()); }
    byId('night-veil').style.opacity = settings.nightDim && (hours >= 22 || hours < 7) ? '0.25' : '0';
  }
  function updatePlay() {
    text('play-label', paused ? 'Play' : 'Pause');
    byId('play-button').setAttribute('aria-label', paused ? 'Play slideshow' : 'Pause slideshow');
    byId('play-icon').setAttribute('href', paused ? '#i-play' : '#i-pause');
    byId('play-icon').setAttributeNS('http://www.w3.org/1999/xlink', 'href', paused ? '#i-play' : '#i-pause');
  }
  function updateConnection() {
    if (standalone) { text('connection-status', 'Hosted art gallery'); return; }
    text('connection-status', connected ? 'Local companion connected' : (serverUrl ? 'Offline · local controls' : 'Local collection'));
    byId('connection-status').classList.toggle('is-connected', connected);
    byId('companion-link').textContent = serverUrl || 'Set your companion server below';
    byId('companion-link').setAttribute('href', serverUrl || '#');
    if (document.activeElement !== byId('companion-url')) byId('companion-url').value = serverUrl;
    text('companion-detail', connected ? 'Connected to your local companion. Photos and settings sync while the server is running.' : (serverUrl ? 'The companion is offline. Keep the server running on your computer, on the same Wi-Fi as the TV.' : 'The gallery also works offline with its built-in collection.'));
  }
  function applyState(state) {
    if (!state || !Array.isArray(state.artworks) || !state.settings) return false;
    var nextCatalog = validCatalog(state.artworks, true);
    if (!nextCatalog.length && localCatalog.length) nextCatalog = localCatalog;
    var catalogChanged = JSON.stringify(nextCatalog) !== JSON.stringify(catalog);
    catalog = nextCatalog;
    settings = normalizeSettings(state.settings);
    if (state.currentId && state.currentId !== currentId) {
      currentId = state.currentId;
      lastAdvance = Date.now();
    }
    paused = state.paused === true;
    var appsChanged = JSON.stringify(state.connection || {}) !== JSON.stringify(tvConnection);
    tvConnection = state.connection || { paired: false, apps: [] };
    connected = true;
    applyAppearance();
    updatePlay();
    updateConnection();
    showArtwork(false);
    if (catalogChanged && panel === 'collection') renderCollection();
    if (appsChanged && panel === 'apps') renderApps();
    saveLocal();
    return true;
  }
  function poll() {
    if (standalone || !serverUrl || polling || pending || postQueue.length || launchingId) return;
    polling = true;
    var requestedServer = serverUrl;
    request(requestedServer + '/api/state', 'GET', null, function (error, state) {
      polling = false;
      if (pending || postQueue.length || serverUrl !== requestedServer) return;
      if (error || !applyState(state)) {
        var wasConnected = connected;
        connected = false;
        updateConnection();
        if (wasConnected && localCatalog.length) {
          catalog = localCatalog;
          showArtwork(false);
          if (panel === 'collection') renderCollection();
        }
        if (panel === 'apps') renderApps();
      }
    });
  }
  function post(path, payload) {
    if (standalone || !serverUrl) return;
    postQueue.push({ path: path, payload: payload, server: serverUrl });
    flushPostQueue();
  }
  function flushPostQueue() {
    if (pending || !postQueue.length) return;
    var next = postQueue.shift();
    pending = 1;
    request(next.server + next.path, 'POST', next.payload, function (error, state) {
      pending = 0;
      if (next.server !== serverUrl) { flushPostQueue(); return; }
      if (error) {
        connected = false;
        updateConnection();
        showToast('Companion offline. This change is saved on the TV.');
      } else if (!postQueue.length) {
        if (!applyState(state)) poll();
      }
      flushPostQueue();
    });
  }
  function step(direction) {
    if (!catalog.length) return;
    var index = catalog.findIndex(function (artwork) { return artwork.id === currentId; });
    index = (index + direction + catalog.length) % catalog.length;
    currentId = catalog[index].id;
    lastAdvance = Date.now();
    showArtwork(false);
  }
  function action(type, id) {
    if (type === 'next') step(1);
    else if (type === 'previous') step(-1);
    else if (type === 'togglePause') { paused = !paused; lastAdvance = Date.now(); updatePlay(); }
    else if (type === 'select') { currentId = id; lastAdvance = Date.now(); showArtwork(false); }
    saveLocal();
    post('/api/action', id ? { type: type, id: id } : { type: type });
  }
  function changeSetting(key, value) {
    settings[key] = value;
    settings = normalizeSettings(settings);
    applyAppearance();
    saveLocal();
    lastAdvance = Date.now();
    var patch = {};
    patch[key] = settings[key];
    post('/api/settings', patch);
  }
  function cycleSetting(key) {
    var options = { frame: ['walnut', 'ivory', 'none'], mat: ['linen', 'dark', 'none'], intervalSeconds: [60, 300, 600, 900, 1800, 3600] };
    if (options[key]) changeSetting(key, options[key][(options[key].indexOf(settings[key]) + 1) % options[key].length]);
    else changeSetting(key, !settings[key]);
  }
  function showToast(message) {
    clearTimeout(toastTimer);
    text('toast', message);
    byId('toast').classList.add('is-visible');
    toastTimer = setTimeout(function () { byId('toast').classList.remove('is-visible'); }, 4500);
  }
  function scheduleHide() {
    clearTimeout(hideTimer);
    if (controlsOpen && !panel) hideTimer = setTimeout(hideControls, 14000);
  }
  function focusAfterReveal(findTarget, isCurrent) {
    function attempt(remaining) {
      if (!isCurrent()) return;
      var target = findTarget();
      if (!target) return;
      // Flush the reveal style before focusing; webOS ignores focus on hidden controls.
      if (window.getComputedStyle(target).visibility === 'hidden') {
        if (remaining > 0) window.requestAnimationFrame(function () { attempt(remaining - 1); });
      } else target.focus();
    }
    window.requestAnimationFrame(function () { attempt(3); });
  }
  function showControls(focus) {
    controlsOpen = true;
    gallery.classList.add('is-interacting');
    byId('controls').setAttribute('aria-hidden', 'false');
    if (focus) focusAfterReveal(function () { return lastDockFocus || byId('play-button'); }, function () { return controlsOpen && !panel; });
    scheduleHide();
  }
  function hideControls() {
    if (panel) return;
    controlsOpen = false;
    gallery.classList.remove('is-interacting');
    byId('controls').setAttribute('aria-hidden', 'true');
    if (document.activeElement && byId('controls').contains(document.activeElement)) document.activeElement.blur();
    clearTimeout(hideTimer);
  }
  function openPanel(name) {
    closePanel(false);
    showControls(false);
    panel = name;
    gallery.classList.add('has-panel');
    byId(name + '-panel').hidden = false;
    if (name === 'collection') renderCollection();
    if (name === 'apps') renderApps();
    if (name === 'companion') updateConnection();
    clearTimeout(hideTimer);
    focusAfterReveal(function () {
      var preferred = name === 'collection' ? '.art-card' : name === 'apps' ? '.app-tile' : '';
      return (preferred && byId(name + '-panel').querySelector(preferred)) || byId(name + '-panel').querySelector('button');
    }, function () { return controlsOpen && panel === name; });
  }
  function closePanel(restoreFocus) {
    if (panel) byId(panel + '-panel').hidden = true;
    panel = '';
    gallery.classList.remove('has-panel');
    if (restoreFocus) showControls(true);
  }
  function markCurrentCard() {
    var cards = byId('collection-grid').querySelectorAll('.art-card');
    for (var i = 0; i < cards.length; i += 1) {
      var isCurrent = cards[i].getAttribute('data-id') === currentId;
      cards[i].classList.toggle('is-current', isCurrent);
      cards[i].setAttribute('aria-pressed', isCurrent ? 'true' : 'false');
    }
  }
  var favoriteApps = ['netflix', 'youtube.leanback.v4', 'amazon', 'com.disney.disneyplus-prod', 'com.apple.appletv', 'spotify-beehive', 'artcast.tv', 'com.wbd.stream'];
  var appDesigns = {
    netflix: { mark: 'N', color: '#a82d32', title: 'Netflix' },
    'youtube.leanback.v4': { mark: '▶', color: '#b14436', title: 'YouTube' },
    amazon: { mark: 'p', color: '#365b71', title: 'Prime Video' },
    'com.disney.disneyplus-prod': { mark: 'D+', color: '#344666', title: 'Disney+' },
    'com.apple.appletv': { mark: 'tv', color: '#4d4b46', title: 'Apple TV' },
    'spotify-beehive': { mark: 'S', color: '#39654e', title: 'Spotify' },
    'artcast.tv': { mark: 'A', color: '#8d7052', title: 'Artcast' },
    'com.wbd.stream': { mark: 'HBO', color: '#51405e', title: 'HBO Max' }
  };
  function userApps() {
    var seen = {};
    return (Array.isArray(tvConnection.apps) ? tvConnection.apps : []).filter(function (app) {
      if (!app || typeof app.id !== 'string' || typeof app.title !== 'string' || seen[app.id]) return false;
      seen[app.id] = true;
      if (/^(com\.(webos|palm)\.|webos\.|amazon\.alexa|google\.assistant|yandex\.alice)/i.test(app.id)) return false;
      if (['airplay', 'epoxyaisports', 'com.twin.app.gamingportal', 'com.milan.wallgallery'].indexOf(app.id) !== -1) return false;
      return !/example|system utility|overlay|first.use|service.launcher/i.test(app.id + ' ' + app.title);
    }).sort(function (a, b) {
      var ai = favoriteApps.indexOf(a.id);
      var bi = favoriteApps.indexOf(b.id);
      if (ai < 0) ai = 100;
      if (bi < 0) bi = 100;
      return ai - bi || a.title.localeCompare(b.title);
    });
  }
  function appDesign(app, index) {
    if (appDesigns[app.id]) return appDesigns[app.id];
    var colors = ['#53634e', '#7d5847', '#4b6069', '#756449', '#65526a', '#526963'];
    var words = app.title.trim().split(/\s+/);
    return { mark: words.length > 1 ? words[0].charAt(0) + words[1].charAt(0) : app.title.slice(0, 2), color: colors[index % colors.length], title: app.title };
  }
  function renderApps() {
    var grid = byId('apps-grid');
    var focusedId = document.activeElement && document.activeElement.getAttribute('data-app-id');
    grid.textContent = '';
    var available = connected && tvConnection.paired === true;
    var apps = userApps();
    var unavailable = !available || !apps.length;
    byId('apps-unavailable').hidden = !unavailable;
    text('apps-status', available ? 'Your TV is connected. Choose an app to open it.' : 'Pair the TV from your phone companion to open apps here.');
    text('apps-count', available ? apps.length + (apps.length === 1 ? ' app' : ' apps') : '');
    text('apps-unavailable-message', !connected ? 'The local companion is offline. Start it on your computer, then pair your TV from your phone.' : !tvConnection.paired ? 'Pair your TV from the phone companion to see your installed apps here.' : 'This TV has not shared its installed apps. Reconnect it from your phone companion.');
    if (!available) return;
    apps.forEach(function (app, index) {
      var design = appDesign(app, index);
      var tile = document.createElement('button');
      tile.className = 'app-tile';
      tile.setAttribute('data-app-id', app.id);
      tile.setAttribute('aria-label', 'Open ' + design.title);
      var mark = document.createElement('span');
      mark.className = 'app-monogram';
      mark.style.backgroundColor = design.color;
      mark.textContent = design.mark;
      var title = document.createElement('strong');
      title.textContent = design.title;
      var note = document.createElement('small');
      note.textContent = launchingId === app.id ? 'Opening…' : favoriteApps.indexOf(app.id) !== -1 ? 'Favorite' : 'On your TV';
      tile.setAttribute('aria-busy', launchingId === app.id ? 'true' : 'false');
      tile.appendChild(mark); tile.appendChild(title); tile.appendChild(note);
      grid.appendChild(tile);
      if (app.id === focusedId) tile.focus();
    });
  }
  function launchApp(id) {
    if (launchingId) return;
    if (!connected || !tvConnection.paired || !serverUrl) { showToast('Pair your TV from the phone companion first.'); return; }
    var app = userApps().filter(function (item) { return item.id === id; })[0];
    if (!app) return;
    launchingId = id;
    var requestedServer = serverUrl;
    renderApps();
    showToast('Opening ' + (appDesigns[id] ? appDesigns[id].title : app.title) + '…');
    request(serverUrl + '/api/tv/launch', 'POST', { id: id }, function (error, state) {
      launchingId = '';
      if (requestedServer !== serverUrl) return;
      if (error) {
        showToast('Could not open the app. ' + error.message);
        if (panel === 'apps') renderApps();
        poll();
      } else {
        if (!applyState(state)) poll();
        if (panel === 'apps') renderApps();
        showToast('Launch request sent to your TV.');
      }
    }, 15000);
  }
  function confirmDisplay() {
    if (standalone || !serverUrl || document.hidden || !lastRenderedId || !image.classList.contains('is-ready')) return;
    request(serverUrl + '/api/display', 'POST', { currentId: lastRenderedId, rendered: true, width: window.innerWidth, height: window.innerHeight }, function () {});
  }
  function renderCollection() {
    var grid = byId('collection-grid');
    var selected = document.activeElement && document.activeElement.getAttribute('data-id');
    grid.textContent = '';
    var items = catalog.filter(function (artwork) { return filter === 'all' || artwork.kind === filter; });
    text('collection-count', items.length + (items.length === 1 ? ' work' : ' works'));
    if (!items.length) {
      var empty = document.createElement('p');
      empty.className = 'collection-empty';
      empty.textContent = filter === 'photo' ? 'Your favorite moments belong here. Add photos from your phone companion.' : 'Your collection is empty. Connect the companion to add artwork.';
      grid.appendChild(empty);
    }
    items.forEach(function (artwork) {
      var card = document.createElement('button');
      card.className = 'art-card';
      card.setAttribute('data-id', artwork.id);
      var thumbnail = document.createElement('img');
      thumbnail.src = artwork.image;
      thumbnail.alt = '';
      thumbnail.loading = 'lazy';
      var title = document.createElement('strong');
      title.textContent = artwork.title || 'Untitled';
      var artist = document.createElement('small');
      artist.textContent = artwork.artist || (artwork.kind === 'photo' ? 'Your photographs' : 'The collection');
      card.appendChild(thumbnail); card.appendChild(title); card.appendChild(artist);
      grid.appendChild(card);
    });
    markCurrentCard();
    if (selected) {
      var cards = grid.querySelectorAll('.art-card');
      for (var i = 0; i < cards.length; i += 1) if (cards[i].getAttribute('data-id') === selected) cards[i].focus();
    }
  }
  function visibleFocusable() {
    var root = panel ? byId(panel + '-panel') : byId('controls');
    return Array.prototype.filter.call(root.querySelectorAll('button, input, a[href]'), function (element) { return !element.disabled && element.offsetWidth > 0 && element.offsetHeight > 0; });
  }
  function moveFocus(direction) {
    var elements = visibleFocusable();
    var focused = document.activeElement;
    if (elements.indexOf(focused) === -1) { if (elements[0]) elements[0].focus(); return; }
    var rect = focused.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var best = null;
    var bestScore = Infinity;
    elements.forEach(function (candidate) {
      if (candidate === focused) return;
      var box = candidate.getBoundingClientRect();
      var dx = box.left + box.width / 2 - cx;
      var dy = box.top + box.height / 2 - cy;
      var along = direction === 'left' ? -dx : direction === 'right' ? dx : direction === 'up' ? -dy : dy;
      var across = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx);
      if (along < 2) return;
      var score = along + across * 2.5;
      if (score < bestScore) { best = candidate; bestScore = score; }
    });
    if (best) {
      best.focus();
      if (panel) best.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
    }
  }
  function onKey(event) {
    var key = event.key;
    var code = event.keyCode;
    var isBack = key === 'Escape' || key === 'BrowserBack' || code === 461 || code === 27;
    if (isBack) {
      event.preventDefault();
      if (panel) closePanel(true);
      else if (controlsOpen) hideControls();
      else if (window.webOS && typeof window.webOS.platformBack === 'function') window.webOS.platformBack();
      return;
    }
    if (key === 'MediaPlayPause' || code === 19 || code === 415 || code === 10252) { event.preventDefault(); action('togglePause'); showToast(paused ? 'Slideshow paused' : 'Slideshow playing'); return; }
    if (event.target.tagName === 'INPUT') return;
    var directions = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' };
    var direction = directions[code];
    if (direction) {
      event.preventDefault();
      if (!controlsOpen) {
        if (direction === 'left') action('previous');
        else if (direction === 'right') action('next');
        else showControls(true);
      } else moveFocus(direction);
      scheduleHide();
      return;
    }
    if (code === 13 || key === 'Enter' || key === ' ') {
      event.preventDefault();
      if (!controlsOpen) showControls(true);
      else if (document.activeElement && typeof document.activeElement.click === 'function' && document.activeElement !== document.body) document.activeElement.click();
      scheduleHide();
    }
  }

  document.addEventListener('keydown', onKey);
  document.addEventListener('focusin', function (event) {
    if (byId('controls').contains(event.target) && event.target.tagName === 'BUTTON') lastDockFocus = event.target;
    scheduleHide();
  });
  document.addEventListener('click', function (event) {
    var button = event.target.closest('button');
    if (button) {
      if (button.hasAttribute('data-action')) action(button.getAttribute('data-action'));
      else if (button.hasAttribute('data-panel')) openPanel(button.getAttribute('data-panel'));
      else if (button.hasAttribute('data-close')) closePanel(true);
      else if (button.hasAttribute('data-setting')) cycleSetting(button.getAttribute('data-setting'));
      else if (button.hasAttribute('data-app-id')) launchApp(button.getAttribute('data-app-id'));
      else if (button.hasAttribute('data-id')) { action('select', button.getAttribute('data-id')); closePanel(false); hideControls(); }
      else if (button.hasAttribute('data-filter')) {
        filter = button.getAttribute('data-filter');
        Array.prototype.forEach.call(document.querySelectorAll('[data-filter]'), function (tab) { tab.classList.toggle('is-active', tab === button); });
        renderCollection();
      }
      scheduleHide();
      return;
    }
    if (!panel && !event.target.closest('#controls')) {
      if (controlsOpen) hideControls();
      else showControls(false);
    }
  });
  byId('brightness-down').addEventListener('click', function () { changeSetting('brightness', clamp(settings.brightness - 5, 25, 100)); });
  byId('brightness-up').addEventListener('click', function () { changeSetting('brightness', clamp(settings.brightness + 5, 25, 100)); });
  byId('companion-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var input = byId('companion-url').value.trim();
    var parsed = cleanServerUrl(input);
    if (input && !parsed) { showToast('Enter an http:// or https:// server address.'); return; }
    serverUrl = parsed;
    postQueue = [];
    connected = false;
    saveLocal();
    updateConnection();
    if (serverUrl) { showToast('Connecting to your companion…'); poll(); }
    else showToast('Using the built-in collection.');
  });
  byId('companion-link').addEventListener('click', function (event) { if (!serverUrl) { event.preventDefault(); byId('companion-url').focus(); } });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { updateClock(); lastAdvance = Date.now(); poll(); } });

  loadLocal();
  if (standalone) {
    Array.prototype.forEach.call(document.querySelectorAll('.dock [data-panel="companion"], .dock [data-panel="apps"], [data-filter="photo"]'), function (element) { element.hidden = true; element.style.display = 'none'; });
    byId('collection-panel').querySelector('.panel-note').textContent = 'Museum artworks are included. Appearance settings save on this device.';
  }
  applyAppearance();
  updatePlay();
  updateConnection();
  request('artworks.json', 'GET', null, function (error, result) {
    localCatalog = validCatalog(Array.isArray(result) ? result : result && result.artworks, false);
    if (!catalog.length) { catalog = localCatalog; showArtwork(false); }
    if (error || !localCatalog.length) byId('empty-state').querySelector('p').textContent = 'Connect your phone companion to add artwork and photos.';
  });
  poll();
  setInterval(poll, 2500);
  setInterval(function () {
    if (document.hidden || connected || paused || !catalog.length) return;
    if (Date.now() - lastAdvance >= settings.intervalSeconds * 1000) step(1);
  }, 1000);
  setInterval(updateClock, 10000);
  setInterval(confirmDisplay, 15000);
  setInterval(function () { clockShift = !clockShift; byId('clock').classList.toggle('is-shifted', clockShift); }, 300000);
  showToast('Press OK for your collection. ← → to browse.');
}());
