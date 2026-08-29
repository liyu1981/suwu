import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import AppShell from './routes/AppShell'
import DemoPage from './routes/DemoPage'
import TermPage from './routes/TermPage'
import ViewerPage from './routes/ViewerPage'
import FileBrowserPage from './routes/FileBrowserPage'

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

// Full-space viewer page, loaded inside each viewer pane's iframe.
const viewerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/viewer',
  component: ViewerPage,
})

// Full-space file browser page, loaded inside each filebrowser pane's iframe.
const filebrowserRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/filebrowser',
  component: FileBrowserPage,
})

const routeTree = rootRoute.addChildren([
  appRoute.addChildren([indexRoute]),
  termRoute,
  viewerRoute,
  filebrowserRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
