import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import AppShell from './routes/AppShell'
import DemoPage from './routes/DemoPage'
import ColorsPage from './routes/ColorsPage'
import TermPage from './routes/TermPage'

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

const colorsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/colors',
  component: ColorsPage,
})

// Full-space terminal page, loaded inside each tiling pane's iframe.
// Lives outside the app shell so it has no header.
const termRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/term',
  component: TermPage,
})

const routeTree = rootRoute.addChildren([
  appRoute.addChildren([indexRoute, colorsRoute]),
  termRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}