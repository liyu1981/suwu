/**
 * Registers every built-in tile plugin.
 *
 * The plugins register themselves through `registerTilePlugin` in a
 * module-level side effect, so *something* has to import each module before
 * `getTilePlugin` can find it. That used to be a block of bare imports inside
 * `TilingWM`; the mobile shell needs the same registry, so it lives here and both
 * shells import this one module.
 */

import './plugins/term';
import './plugins/viewer';
import './plugins/filebrowser';
import './plugins/empty';
import './plugins/forward';
import './plugins/dropbox';
import './plugins/gitgraph';
import './plugins/diff';
import './plugins/xdisplay';
import './plugins/dbbrowser';
import './plugins/code';
import './plugins/resthelper';
import './plugins/extension';
import './plugins/foldersync';
import './plugins/sftp';
import './plugins/staticserve';
import './plugins/staticbrowse';
