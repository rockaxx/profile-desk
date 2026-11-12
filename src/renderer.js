const $ = id => document.getElementById(id);
const api = window.desk;
let workspace = {chrome: false, profiles: []};
let view = 'profiles';
let editing;
let noticeTimeout;
let refreshId = 0;
const pending = new Set();

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content) node.textContent = content;
  return node;
}

function icon(name) {
  const node = element('i', 'ti ti-' + name);
  node.setAttribute('aria-hidden', 'true');
  return node;
}

function notify(message, error = false) {
  clearTimeout(noticeTimeout);
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.hidden = false;
  noticeTimeout = setTimeout(() => {toast.hidden = true;}, error ? 8500 : 4200);
}

async function refresh() {
  const current = ++refreshId;
  try {
    const snapshot = await api.read();
    if (current !== refreshId) return;
    workspace = snapshot;
    render();
  } catch (error) {
    notify(error.message, true);
  }
}

function action(label, symbol, handler, disabled, primary = false) {
  const button = element('button', primary ? 'btn btn-sm btn-primary' : 'icon-button');
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.disabled = disabled;
  button.append(icon(symbol));
  if (primary) button.append(document.createTextNode(label));
  button.addEventListener('click', handler);
  return button;
}

async function run(profile, fn, message) {
  pending.add(profile.id);
  render();
  try {
    const value = await fn(profile.id);
    if (message) notify(message(value));
  } catch (error) {
    notify(error.message, true);
  } finally {
    pending.delete(profile.id);
    await refresh();
  }
}

function profileRow(profile) {
  const row = element('tr');
  const title = element('td');
  const name = element('div', 'profile-label');
  name.append(element('span', 'avatar-mark', Array.from(profile.name).slice(0, 2).join('').toUpperCase()));
  const labels = element('div');
  labels.append(element('strong', '', profile.name), element('span', profile.running ? 'meta running' : 'meta', profile.running ? 'Chrome open' : 'Closed'));
  if (profile.notes) {
    const note = element('span', 'meta profile-note', profile.notes);
    note.title = profile.notes;
    labels.append(note);
  }
  name.append(labels);
  title.append(name);

  const connection = element('td');
  connection.append(element('strong', '', profile.scheme === 'direct' ? 'Direct' : profile.scheme.toUpperCase()));
  if (profile.host) connection.append(element('span', 'meta', profile.host + ':' + profile.port));

  const checked = element('td');
  if (profile.result?.ip) {
    const details = element('span', 'meta', profile.result.duration + ' ms · ' + new Date(profile.result.checkedAt).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'}));
    checked.append(element('strong', '', profile.result.ip), details);
  } else if (profile.result?.error) {
    checked.append(element('span', 'meta failed', profile.result.error));
  } else {
    checked.append(element('span', 'meta', 'Not checked'));
  }

  const controls = element('td');
  const buttons = element('div', 'actions');
  const busy = pending.has(profile.id);
  buttons.append(
    action('Test connection', 'activity', () => run(profile, api.test, result => 'Connection verified · ' + result.ip), busy),
    action('Network and privacy diagnostics', 'shield-check', () => showDiagnostics(profile), busy),
    action('Edit profile', 'pencil', () => showEditor(profile), busy || profile.running),
    action('Remove profile', 'trash', () => askRemove(profile), busy || profile.running)
  );
  if (view === 'profiles') {
    buttons.append(action('Open in Android', 'device-mobile', () => showAndroid(profile), busy));
    buttons.append(action(profile.running ? 'Open now' : 'Open', 'external-link', () => run(profile, api.open), busy || profile.running || !workspace.chrome, true));
  }
  controls.append(buttons);
  row.append(title, connection, checked, controls);
  return row;
}

function render() {
  const profiles = workspace.profiles;
  const proxied = profiles.filter(profile => profile.scheme !== 'direct');
  const connections = view === 'connections';
  const list = connections ? proxied : profiles;
  const query = $('search').value.trim().toLowerCase();
  const shown = list.filter(profile => [profile.name, profile.notes, profile.host, profile.scheme, profile.result?.ip].some(value => value?.toLowerCase().includes(query)));

  $('chrome-state').classList.toggle('missing', !workspace.chrome);
  $('chrome-label').textContent = workspace.chrome ? 'Chrome detected' : 'Chrome not installed';
  $('count-profiles').textContent = profiles.length;
  $('count-running').textContent = profiles.filter(profile => profile.running).length;
  $('count-proxies').textContent = proxied.length;
  $('crumb-view').textContent = connections ? 'Connections' : 'Profiles';
  $('heading').textContent = connections ? 'Proxy connections' : 'Browser profiles';
  $('description').textContent = connections ? 'Check routing and exit IP for each proxy profile.' : 'Separate Chrome sessions for each client and project.';
  $('table-heading').textContent = connections ? 'Configured proxies' : 'All profiles';
  $('rows').replaceChildren(...shown.map(profileRow));
  $('table-wrap').hidden = !shown.length;
  $('empty').hidden = Boolean(shown.length);
  $('empty-create').hidden = Boolean(list.length);
  $('empty-title').textContent = list.length ? 'No matches' : connections ? 'No proxy profiles yet' : 'Create your first profile';
  $('empty-description').textContent = list.length ? 'Try a different search.' : connections ? 'Add a profile with an HTTP, HTTPS or SOCKS5 proxy.' : 'Give a client or project its own Chrome session.';
}

function updateFields() {
  const form = $('profile-form');
  const hasProxy = form.scheme.value !== 'direct';
  $('proxy-fields').hidden = !hasProxy;
  form.host.required = hasProxy;
  form.port.required = hasProxy;
  for (const field of ['host', 'port', 'username', 'password', 'clearPassword']) {
    form.elements[field].disabled = !hasProxy;
  }
}

function showEditor(profile) {
  const form = $('profile-form');
  form.reset();
  editing = profile;
  $('editor-title').textContent = profile ? 'Edit profile' : 'New profile';
  $('form-error').hidden = true;
  $('clear-wrap').hidden = !profile?.hasPassword;
  $('host-os').textContent = workspace.hostOs ?? 'Unknown';
  $('advanced').open = false;
  form.password.placeholder = profile?.hasPassword ? 'Saved password' : 'Optional';
  if (profile) {
    for (const field of ['name', 'scheme', 'host', 'port', 'username', 'notes', 'windowWidth', 'windowHeight',
      'scaleFactor', 'browserLanguage', 'qaUserAgent', 'qaTimezone', 'qaLatitude', 'qaLongitude']) {
      form.elements[field].value = profile[field] ?? '';
    }
    form.elements.startupUrls.value = (profile.startupUrls ?? []).join('\n');
    form.elements.preferredLanguages.value = (profile.preferredLanguages ?? []).join(', ');
    form.elements.windowPreset.value = profile.windowPreset ?? 'default';
    for (const field of ['webRtcPolicy', 'locationPermission', 'graphicsPrivacy']) {
      form.elements[field].value = profile[field] ?? 'chrome-default';
    }
  } else if (view === 'connections') {
    form.scheme.value = 'http';
  }
  updateFields();
  updateWindowFields();
  $('editor').showModal();
  form.elements.name.focus();
}

let diagnosticSequence = 0;
let androidSequence = 0;
let androidProfile;
let androidViewer;
let androidFrameTimer;
let androidFrameSequence = 0;
let androidPointer;
let androidInputPending = false;

async function showAndroid(profile) {
  const form = $('android-form');
  androidProfile = profile;
  form.reset();
  $('android-profile').textContent = profile.name;
  $('android').showModal();
  await refreshAndroidDevices();
}

async function refreshAndroidDevices() {
  const sequence = ++androidSequence;
  const status = $('android-status');
  $('android-controls').hidden = true;
  $('android-refresh').hidden = true;
  $('android-setup').hidden = true;
  $('android-consent').hidden = true;
  $('android-setup').disabled = !$('android-license').checked;
  $('android-launch').hidden = true;
  $('android-launch').disabled = true;
  hideAndroidViewer();
  $('android-phone-size').hidden = !workspace.chrome || androidProfile.running;
  $('android-phone-size').disabled = false;
  status.classList.remove('failed');
  status.textContent = 'Finding Android virtual devices…';
  try {
    const {sdkReady, devices, startupUrl, setupSupported, setup, hypervisorOption, viewer, proxied} = await api.androidDevices(androidProfile.id);
    if (sequence !== androidSequence) return;
    renderAndroidSetup(setup);
    if (setup.status === 'running') return;
    if (viewer) {
      showAndroidViewer(viewer);
      return;
    }
    $('android-refresh').hidden = false;
    $('android-consent').hidden = $('android-setup').hidden = !setupSupported || Boolean(devices.length);
    $('android-hypervisor-option').hidden = !hypervisorOption;
    if (setup.status === 'failed' && !devices.length) return;
    if (!sdkReady) {
      status.textContent = setupSupported
        ? 'Android SDK not found. Install the emulator and create a test phone from here.'
        : 'Android SDK not found. Install Android Emulator and SDK Platform-Tools in Android Studio.';
      return;
    }
    if (!devices.length) {
      status.textContent = setupSupported
        ? 'No virtual devices found. Install Android tools to create a test phone.'
        : 'No virtual devices found. Create a device with Chrome in Android Studio Device Manager.';
      return;
    }
    $('android-device').replaceChildren(...devices.map(device => {
      const option = element('option', '', device);
      option.value = device;
      return option;
    }));
    $('android-url').value = startupUrl;
    $('android-url').disabled = proxied;
    $('android-url-help').textContent = proxied
      ? 'Chrome opens a fresh IP check through this profile’s proxy. Local QA URLs need a Direct profile.'
      : 'Leave blank to open Chrome. Android uses its own browser data.';
    status.textContent = setup.restartRequired ? 'Restart Windows before opening the emulator.' : 'Choose a virtual device with Chrome installed.';
    $('android-controls').hidden = false;
    $('android-launch').hidden = false;
    $('android-launch').disabled = setup.restartRequired;
  } catch (error) {
    if (sequence !== androidSequence) return;
    $('android-refresh').hidden = false;
    status.classList.add('failed');
    status.textContent = error.message;
  }
}

function pauseAndroidFrames() {
  androidFrameSequence++;
  clearTimeout(androidFrameTimer);
}

function hideAndroidViewer() {
  pauseAndroidFrames();
  androidViewer = undefined;
  androidPointer = undefined;
  $('android').classList.remove('has-android-viewer', 'is-expanded');
  setAndroidExpanded(false);
  $('android-status').parentElement.removeAttribute('data-state');
  $('android-viewer').hidden = true;
  $('android-stop').hidden = true;
  $('android-frame-placeholder').hidden = false;
  $('android-screen').hidden = true;
  $('android-screen').removeAttribute('src');
}

function showAndroidViewer(viewer) {
  pauseAndroidFrames();
  androidViewer = viewer;
  const id = androidProfile.id;
  const sequence = androidFrameSequence;
  const status = $('android-status');
  const screen = $('android-screen');
  const statusBar = status.parentElement;
  $('android').classList.add('has-android-viewer');
  for (const control of ['android-controls', 'android-consent', 'android-setup-log', 'android-setup', 'android-refresh', 'android-launch', 'android-phone-size']) {
    $(control).hidden = true;
  }
  $('android-viewer').hidden = false;
  $('android-active-device').textContent = viewer.avd;
  $('android-viewer').dataset.zoom = $('android-zoom').value;
  $('android-viewer').inert = false;
  $('android-stop').hidden = false;
  $('android-stop').disabled = false;
  status.classList.remove('failed');
  statusBar.dataset.state = 'waiting';
  status.textContent = 'Connecting to the Android screen…';
  const route = viewer.proxyIp ? 'Chrome proxy configured · Gateway IP ' + viewer.proxyIp : 'Direct connection';
  const connected = viewer.warning ? route + ' · ' + viewer.warning : route;
  const update = async () => {
    let interval = 350;
    try {
      const src = await api.androidFrame(id);
      if (sequence !== androidFrameSequence) return;
      screen.src = src;
      screen.hidden = false;
      $('android-frame-placeholder').hidden = true;
      status.classList.remove('failed');
      statusBar.dataset.state = viewer.warning ? 'waiting' : 'live';
      if (status.textContent !== connected) status.textContent = connected;
    } catch {
      if (sequence !== androidFrameSequence) return;
      status.classList.add('failed');
      statusBar.dataset.state = 'waiting';
      if (status.textContent !== 'Waiting for the Android screen…') status.textContent = 'Waiting for the Android screen…';
      interval = 1300;
    }
    if (sequence === androidFrameSequence) androidFrameTimer = setTimeout(update, interval);
  };
  update();
}

$('android-zoom').addEventListener('change', event => {$('android-viewer').dataset.zoom = event.target.value;});
function setAndroidExpanded(expanded) {
  const button = $('android-expand');
  $('android').classList.toggle('is-expanded', expanded);
  button.setAttribute('aria-pressed', String(expanded));
  button.title = expanded ? 'Restore viewer' : 'Expand viewer';
  button.setAttribute('aria-label', button.title);
  button.firstElementChild.className = expanded ? 'ti ti-minimize' : 'ti ti-maximize';
}
$('android-expand').addEventListener('click', () => {
  setAndroidExpanded(!$('android').classList.contains('is-expanded'));
});
$('android-phone-size').addEventListener('click', async () => {
  const button = $('android-phone-size');
  const sequence = androidSequence;
  button.disabled = true;
  try {
    await api.openPhoneSize(androidProfile.id);
    if (sequence === androidSequence) $('android').close();
  } catch (error) {
    if (sequence === androidSequence) $('android-status').textContent = error.message;
  } finally {
    if (sequence === androidSequence) button.disabled = false;
  }
});

async function sendAndroidInput(action) {
  if (!androidViewer || androidInputPending || $('android-viewer').inert) return false;
  androidInputPending = true;
  try {
    await api.androidInput(androidProfile.id, action);
    return true;
  } catch (error) {
    notify(error.message, true);
    return false;
  } finally {
    androidInputPending = false;
  }
}

function androidScreenPoint(event) {
  const screen = $('android-screen');
  const bounds = screen.getBoundingClientRect();
  if (!screen.naturalWidth || !screen.naturalHeight || !bounds.width || !bounds.height) return null;
  const translate = (value, start, length, pixels) => Math.max(0, Math.min(pixels - 1, Math.floor((value - start) * pixels / length)));
  return {x:translate(event.clientX, bounds.left, bounds.width, screen.naturalWidth),
    y:translate(event.clientY, bounds.top, bounds.height, screen.naturalHeight)};
}

$('android-screen').addEventListener('pointerdown', event => {
  if (event.button !== 0 || !androidViewer) return;
  const point = androidScreenPoint(event);
  if (!point) return;
  androidPointer = {id:event.pointerId, point, time:performance.now(), left:event.clientX, top:event.clientY};
  event.currentTarget.setPointerCapture(event.pointerId);
});
$('android-screen').addEventListener('pointercancel', () => {androidPointer = undefined;});
$('android-screen').addEventListener('pointerup', event => {
  const start = androidPointer;
  androidPointer = undefined;
  if (!start || start.id !== event.pointerId) return;
  const end = androidScreenPoint(event);
  if (!end) return;
  if (Math.hypot(event.clientX - start.left, event.clientY - start.top) < 8) {
    sendAndroidInput({kind:'tap', ...end});
  } else {
    const duration = Math.max(120, Math.min(900, Math.round(performance.now() - start.time)));
    sendAndroidInput({kind:'swipe', ...start.point, endX:end.x, endY:end.y, duration});
  }
});
for (const button of document.querySelectorAll('[data-android-key]')) {
  button.addEventListener('click', () => sendAndroidInput({kind:'key', key:button.dataset.androidKey}));
}
$('android-send-text').addEventListener('click', async () => {
  const field = $('android-type');
  if (field.value && await sendAndroidInput({kind:'text', text:field.value})) field.value = '';
});
$('android-type').addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  $('android-send-text').click();
});
$('android-stop').addEventListener('click', async () => {
  const viewer = androidViewer;
  const sequence = androidSequence;
  if (!viewer) return;
  pauseAndroidFrames();
  $('android-viewer').inert = true;
  $('android-stop').disabled = true;
  $('android-status').parentElement.dataset.state = 'waiting';
  $('android-status').textContent = 'Stopping Android…';
  try {
    await api.stopAndroid(androidProfile.id);
    if (sequence !== androidSequence) return;
    await refreshAndroidDevices();
    notify('Android stopped.');
  } catch (error) {
    if (sequence !== androidSequence) return;
    showAndroidViewer(viewer);
    notify(error.message, true);
  }
});

function renderAndroidSetup(setup) {
  const log = $('android-setup-log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 35;
  log.hidden = !setup.log;
  log.textContent = setup.log.replace(/\[PROFILE_DESK_RESTART_REQUIRED\]\s*/g, '');
  if (atBottom) log.scrollTop = log.scrollHeight;
  const status = $('android-status');
  if (setup.status === 'running') {
    $('android-controls').hidden = true;
    $('android-consent').hidden = true;
    $('android-setup').hidden = true;
    $('android-refresh').hidden = true;
    $('android-launch').hidden = true;
    status.classList.remove('failed');
    status.textContent = 'Installing Android tools…';
  } else if (setup.status === 'failed') {
    status.classList.add('failed');
    status.textContent = 'Android setup failed. Check the output and retry.';
  }
}

$('android-refresh').addEventListener('click', refreshAndroidDevices);
$('android-license').addEventListener('change', () => {$('android-setup').disabled = !$('android-license').checked;});
$('android-read-license').addEventListener('click', () => api.openAndroidLicense().catch(error => notify(error.message, true)));
api.onAndroidSetup(setup => {
  if (!$('android').open) return;
  renderAndroidSetup(setup);
  if (setup.status === 'success' || setup.status === 'failed') refreshAndroidDevices();
});
$('android-setup').addEventListener('click', async () => {
  const sequence = androidSequence;
  const button = $('android-setup');
  const status = $('android-status');
  button.disabled = true;
  status.classList.remove('failed');
  status.textContent = 'Starting Android setup…';
  try {
    await api.setupAndroid({acceptLicense:$('android-license').checked, enableHypervisor:$('android-hypervisor').checked});
  } catch (error) {
    if (sequence !== androidSequence) return;
    status.classList.add('failed');
    status.textContent = error.message;
  } finally {
    if (sequence === androidSequence) button.disabled = !$('android-license').checked;
  }
});

$('android-form').addEventListener('submit', async event => {
  event.preventDefault();
  const sequence = androidSequence;
  const button = $('android-launch');
  const status = $('android-status');
  const avd = $('android-device').value;
  button.disabled = true;
  status.classList.remove('failed');
  status.textContent = 'Waiting for ' + avd + ' to start…';
  try {
    const viewer = await api.openAndroid({id:androidProfile.id, avd, url:$('android-url').value});
    if (sequence === androidSequence) showAndroidViewer(viewer);
  } catch (error) {
    if (sequence !== androidSequence) return;
    status.classList.add('failed');
    status.textContent = error.message;
  } finally {
    if (sequence === androidSequence) button.disabled = false;
  }
});

$('android-dismiss').addEventListener('click', () => $('android').close());
$('android').addEventListener('close', () => {androidSequence++; hideAndroidViewer();});

async function showDiagnostics(profile) {
  const dialog = $('diagnostics');
  const status = $('diagnostics-status');
  const rows = $('diagnostics-rows');
  const sequence = ++diagnosticSequence;
  $('diagnostics-profile').textContent = profile.name;
  status.textContent = 'Checking IPv4, IPv6 and a local Chrome sample…';
  rows.replaceChildren();
  dialog.showModal();
  const add = (key, value) => rows.append(element('dt', '', key), element('dd', '', value));
  try {
    const {route, browser} = await api.diagnose(profile.id);
    if (sequence !== diagnosticSequence) return;
    const address = result => result.ip ? result.ip + ' · ' + result.duration + ' ms' : result.error;
    add('Public IPv4', address(route.ipv4));
    add('Public IPv6', address(route.ipv6));
    add('Proxy authentication', route.authentication);
    if (browser.error) {
      status.textContent = 'Network checks complete. Browser diagnostics unavailable.';
      add('Chrome sample', browser.error);
      return;
    }
    const {native, qa, dns, warnings} = browser;
    status.textContent = 'IP and response time from ipify. Browser values measured in a separate, local headless Chrome session.';
    add('DNS sample', dns);
    add('WebRTC IP sample', native.ice
      ? native.ice.numericAddresses + ' numeric IP candidate(s), ' + native.ice.mdnsAddresses + ' mDNS, ' + native.ice.udpCandidates + ' UDP. ' +
        (native.ice.complete ? 'Gathering finished.' : 'Gathering timed out.') + ' No STUN server used.'
      : 'WebRTC API unavailable in the sample.');
    add('Chrome User-Agent', native.userAgent);
    add('Accept-Language', native.acceptLanguageHeader ?? 'Unavailable');
    add('Browser languages', native.languages.join(', '));
    add('Time zone', native.timeZone);
    add('Screen / viewport', native.screen.join(' × ') + ' / ' + native.viewport.join(' × '));
    add('Device scale factor', String(native.scaleFactor));
    add('Location permission', native.locationPermission);
    add('Graphics APIs', 'Canvas 2D ' + (native.canvas ? 'available' : 'unavailable') + ' · WebGL ' + (native.webgl ? 'available' : 'unavailable'));
    add('Canvas readback', native.canvasReadback ? 'Available' : 'Unavailable in the sample');
    if (qa.userAgent) add('Local QA User-Agent', qa.userAgent);
    if (qa.timeZone) add('Local QA time zone', qa.timeZone);
    if (qa.location) add('Local QA position', qa.location.join(', '));
    for (const warning of warnings) add('Warning', warning);
  } catch (error) {
    if (sequence === diagnosticSequence) status.textContent = error.message;
  }
}

function updateWindowFields() {
  const form = $('profile-form');
  const custom = form.elements.windowPreset.value === 'custom';
  $('custom-size').hidden = !custom;
  for (const name of ['windowWidth', 'windowHeight']) {
    form.elements[name].disabled = !custom;
    form.elements[name].required = custom;
  }
}

function askRemove(profile) {
  const dialog = $('remove-dialog');
  $('remove-message').textContent = 'Remove ' + profile.name + ' from Profile Desk? Chrome browsing data stays on this device.';
  dialog.returnValue = 'cancel';
  dialog.addEventListener('close', () => {
    if (dialog.returnValue === 'remove') run(profile, api.remove, () => 'Profile removed');
  }, {once: true});
  dialog.showModal();
}

$('profile-form').addEventListener('submit', async event => {
  event.preventDefault();
  const save = $('save');
  save.disabled = true;
  $('form-error').hidden = true;
  try {
    const data = Object.fromEntries(new FormData(event.currentTarget));
    await api.save({...data, id: editing?.id});
    $('editor').close();
    notify('Profile saved');
    await refresh();
  } catch (error) {
    $('form-error').textContent = error.message;
    $('form-error').hidden = false;
    $('form-error').scrollIntoView({block: 'nearest'});
  } finally {
    save.disabled = false;
  }
});
$('scheme').addEventListener('change', updateFields);
$('window-preset').addEventListener('change', updateWindowFields);
$('diagnostics-close').addEventListener('click', () => $('diagnostics').close());
for (const id of ['new-profile', 'empty-create']) $(id).addEventListener('click', () => showEditor());
for (const id of ['dismiss', 'cancel']) $(id).addEventListener('click', () => $('editor').close());
$('search').addEventListener('input', render);
for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => {
    view = button.dataset.view;
    $('search').value = '';
    for (const item of document.querySelectorAll('[data-view]')) {
      item.classList.toggle('selected', item === button);
      if (item === button) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
    render();
  });
}

api.onChange(refresh);
api.onQuitBlocked(message => notify(message, true));
refresh();
