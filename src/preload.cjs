const {contextBridge, ipcRenderer} = require('electron');

async function invoke(channel, input) {
  const result = await ipcRenderer.invoke(channel, input);
  if (result.error) throw Error(result.error);
  return result.value;
}

contextBridge.exposeInMainWorld('desk', {
  read: () => invoke('workspace:read'),
  save: profile => invoke('profile:save', profile),
  remove: id => invoke('profile:remove', id),
  open: id => invoke('profile:open', id),
  openPhoneSize: id => invoke('profile:open-phone-size', id),
  test: id => invoke('profile:test', id),
  diagnose: id => invoke('profile:diagnose', id),
  androidDevices: id => invoke('android:devices', id),
  openAndroid: options => invoke('android:open', options),
  androidFrame: id => invoke('android:frame', id),
  androidInput: (id, action) => invoke('android:input', {id, action}),
  stopAndroid: id => invoke('android:stop', id),
  setupAndroid: options => invoke('android:setup', options),
  openAndroidLicense: () => invoke('android:license'),
  onAndroidSetup: callback => {ipcRenderer.on('android:setup-progress', (_event, snapshot) => callback(snapshot));},
  onChange: callback => {ipcRenderer.on('profiles:changed', () => callback());},
  onQuitBlocked: callback => {ipcRenderer.on('workspace:quit-blocked', (_event, message) => callback(message));}
});
