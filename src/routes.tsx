import { createBrowserRouter, type RouteObject } from "react-router";
import { Shell } from "./App";
import { CubePage } from "./pages/CubePage";
import { IndexPage } from "./pages/IndexPage";
import { NotFoundPage, PageErrorPage, RouteErrorPage } from "./pages/NotFoundPage";
import { ReviewPage } from "./pages/ReviewPage";
import { ThreadPage } from "./pages/ThreadPage";
import { WorkspacePage } from "./pages/WorkspacePage";

/** The app's routes, apart from the router so a test can mount them in memory. */
export const routes: RouteObject[] = [
  { path: "/", element: <IndexPage />, errorElement: <RouteErrorPage /> },
  {
    path: "/w/:ws",
    element: <Shell />,
    errorElement: <RouteErrorPage />,
    children: [
      {
        // A page that fails shows its fault in the shell's <main>; the sidebar stays.
        errorElement: <PageErrorPage />,
        children: [
          { index: true, element: <WorkspacePage /> },
          { path: "t/:threadId", element: <ThreadPage /> },
          // The key user's review: the list, and the list with one entry open.
          { path: "review", element: <ReviewPage /> },
          { path: "review/:entryId", element: <ReviewPage /> },
        ],
      },
    ],
  },
  { path: "/cube", element: <CubePage /> },
  { path: "*", element: <NotFoundPage /> },
];

export const router = createBrowserRouter(routes);
