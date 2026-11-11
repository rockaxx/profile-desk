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
    action('Edit profile', 'pencil', () => showEditor(profile), busy || profile.running),
    action('Remove profile', 'trash', () => askRemove(profile), busy || profile.running)
  );
  if (view === 'profiles') {
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
  const shown = list.filter(profile => [profile.name, profile.host, profile.scheme, profile.result?.ip].some(value => value?.toLowerCase().includes(query)));

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
  form.password.placeholder = profile?.hasPassword ? 'Saved password' : 'Optional';
  if (profile) {
    for (const field of ['name', 'scheme', 'host', 'port', 'username']) {
      form.elements[field].value = profile[field] ?? '';
    }
  } else if (view === 'connections') {
    form.scheme.value = 'http';
  }
  updateFields();
  $('editor').showModal();
  form.elements.name.focus();
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
  } finally {
    save.disabled = false;
  }
});
$('scheme').addEventListener('change', updateFields);
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
api.onQuitBlocked(() => notify('Close the active Chrome windows before quitting Profile Desk.', true));
refresh();
