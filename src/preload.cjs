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
  test: id => invoke('profile:test', id),
  onChange: callback => {ipcRenderer.on('profiles:changed', () => callback());},
  onQuitBlocked: callback => {ipcRenderer.on('workspace:quit-blocked', () => callback());}
});
