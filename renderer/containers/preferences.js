import electron from 'electron';
import {Container} from 'unstated';
import {ipcRenderer as ipc} from 'electron-better-ipc';

const SETTINGS_ANALYTICS_BLACKLIST = ['kapturesDir'];

export default class PreferencesContainer extends Container {
  remote = electron.remote || false;

  state = {
    category: 'general',
    tab: 'discover',
    isMounted: false
  }

  mount = async setOverlay => {
    this.setOverlay = setOverlay;
    this.settings = this.remote.require('./common/settings');
    this.systemPermissions = this.remote.require('./common/system-permissions');
    this.plugins = this.remote.require('./common/plugins');
    this.track = this.remote.require('./common/analytics').track;

    const pluginsInstalled = this.plugins.getInstalled().sort((a, b) => a.prettyName.localeCompare(b.prettyName));

    this.fetchFromNpm();

    this.setState({
      ...this.settings.store,
      openOnStartup: this.remote.app.getLoginItemSettings().openAtLogin,
      pluginsInstalled,
      isMounted: true
    });

    if (this.settings.store.recordAudio) {
      this.getAudioDevices();
    }
  }

  getAudioDevices = async () => {
    const {getAudioDevices} = this.remote.require('./common/aperture');
    const {audioInputDeviceId} = this.settings.store;

    const audioDevices = await getAudioDevices();
    const updates = {audioDevices};

    if (!audioDevices.some(device => device.id === audioInputDeviceId)) {
      const [device] = audioDevices;
      if (device) {
        this.settings.set('audioInputDeviceId', device.id);
        updates.audioInputDeviceId = device.id;
      }
    }

    this.setState(updates);
  }

  setNavigation = ({category, tab}) => this.setState({category, tab})

  fetchFromNpm = async () => {
    try {
      const plugins = await this.plugins.getFromNpm();
      this.setState({
        npmError: false,
        pluginsFromNpm: plugins.sort((a, b) => {
          if (a.isCompatible !== b.isCompatible) {
            return b.isCompatible - a.isCompatible;
          }

          return a.prettyName.localeCompare(b.prettyName);
        })
      });
    } catch (_) {
      this.setState({npmError: true});
    }
  }

  togglePlugin = plugin => {
    if (plugin.isInstalled) {
      this.uninstall(plugin.name);
    } else {
      this.install(plugin.name);
    }
  }

  install = async name => {
    const {pluginsInstalled, pluginsFromNpm} = this.state;

    this.setState({pluginBeingInstalled: name});
    const result = await this.plugins.install(name);

    if (result) {
      this.setState({
        pluginBeingInstalled: undefined,
        pluginsFromNpm: pluginsFromNpm.filter(p => p.name !== name),
        pluginsInstalled: [result, ...pluginsInstalled].sort((a, b) => a.prettyName.localeCompare(b.prettyName))
      });
    } else {
      this.setState({
        pluginBeingInstalled: undefined
      });
    }
  }

  uninstall = async name => {
    const {pluginsInstalled, pluginsFromNpm} = this.state;

    const onTransitionEnd = async () => {
      const plugin = await this.plugins.uninstall(name);
      this.setState({
        pluginsInstalled: pluginsInstalled.filter(p => p.name !== name),
        pluginsFromNpm: [plugin, ...pluginsFromNpm].sort((a, b) => a.prettyName.localeCompare(b.prettyName)),
        pluginBeingUninstalled: null,
        onTransitionEnd: null
      });
    };

    this.setState({pluginBeingUninstalled: name, onTransitionEnd});
  }

  openPluginsConfig = async name => {
    this.track(`plugin/config/${name}`);
    this.setState({category: 'plugins'});
    this.setOverlay(true);
    await this.plugins.openPluginConfig(name);
    ipc.callMain('refresh-usage');
    this.setOverlay(false);
  }

  openPluginsFolder = () => electron.shell.openItem(this.plugins.cwd);

  selectCategory = category => {
    this.setState({category});
  }

  selectTab = tab => {
    this.track(`preferences/tab/${tab}`);
    this.setState({tab});
  }

  toggleSetting = (setting, value) => {
    // TODO: Fix this ESLint violation
    // eslint-disable-next-line react/no-access-state-in-setstate
    const newVal = value === undefined ? !this.state[setting] : value;
    if (!SETTINGS_ANALYTICS_BLACKLIST.includes(setting)) {
      this.track(`preferences/setting/${setting}/${newVal}`);
    }

    this.setState({[setting]: newVal});
    this.settings.set(setting, newVal);
  }

  toggleRecordAudio = async () => {
    const newVal = !this.state.recordAudio;
    this.track(`preferences/setting/recordAudio/${newVal}`);

    if (!newVal || await this.systemPermissions.ensureMicrophonePermissions()) {
      if (newVal) {
        await this.getAudioDevices();
      }

      this.setState({recordAudio: newVal});
      this.settings.set('recordAudio', newVal);
    }
  }

  toggleShortcuts = async () => {
    const setting = 'recordKeyboardShortcut';
    const newVal = !this.state[setting];
    this.toggleSetting(setting, newVal);
    await ipc.callMain('toggle-shortcuts', {enabled: newVal});
  }

  updateShortcut = async (setting, shortcut) => {
    try {
      await ipc.callMain('update-shortcut', {setting, shortcut});
      this.setState({[setting]: shortcut});
    } catch (error) {
      console.warn('Error updating shortcut', error);
    }
  }

  setOpenOnStartup = value => {
    // TODO: Fix this ESLint violation
    // eslint-disable-next-line react/no-access-state-in-setstate
    const openOnStartup = typeof value === 'boolean' ? value : !this.state.openOnStartup;
    this.setState({openOnStartup});
    this.remote.app.setLoginItemSettings({openAtLogin: openOnStartup});
  }

  pickKapturesDir = () => {
    const {dialog, getCurrentWindow} = this.remote;

    const directories = dialog.showOpenDialogSync(getCurrentWindow(), {
      properties: [
        'openDirectory',
        'createDirectory'
      ]
    });

    if (directories) {
      this.toggleSetting('kapturesDir', directories[0]);
    }
  }

  setAudioInputDeviceId = id => {
    this.setState({audioInputDeviceId: id});
    this.settings.set('audioInputDeviceId', id);
  }
}
