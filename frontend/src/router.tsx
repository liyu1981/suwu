import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import AppShell from './routes/AppShell'
import DemoPage from './routes/DemoPage'
import TermPage from './routes/TermPage'
import FileViewerPage from './routes/FileViewerPage'
import FileBrowserPage from './routes/FileBrowserPage'
import ForwardPage from './routes/ForwardPage'
import DropboxPage from './routes/DropboxPage'
import GitGraphPage from './routes/GitGraphPage'

const rootRoute = createRootRoute()

// App shell (header + content) for the interactive pages.
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  component: AppShell,
})

const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  component: DemoPage,
})

// Full-space terminal page, loaded inside each tiling pane's iframe.
// Lives outside the app shell so it has no header.
const termRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/term',
  component: TermPage,
})

// Full-space file viewer page, loaded inside each file viewer pane's iframe.
const fileViewerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/viewer',
  component: FileViewerPage,
})

// Full-space file browser page, loaded inside each filebrowser pane's iframe.
const filebrowserRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/filebrowser',
  component: FileBrowserPage,
})

// Full-space port forward page, loaded inside each forward pane's iframe.
const forwardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/forward',
  component: ForwardPage,
})

const dropboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/dropbox',
  component: DropboxPage,
})

const gitgraphRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/gitgraph',
  component: GitGraphPage,
})

const routeTree = rootRoute.addChildren([
  appRoute.addChildren([indexRoute]),
  termRoute,
  fileViewerRoute,
  filebrowserRoute,
  forwardRoute,
  dropboxRoute,
  gitgraphRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
