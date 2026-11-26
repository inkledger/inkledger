import { ObservedPage } from "@/lib/workspace/ObservedPage";
import { lazy, Suspense, useEffect, type ComponentType } from "react";
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router";
import { t, useLocale } from "@/i18n";
import { englishReady } from "@contracts/i18n";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { AppLayout } from "@/components/AppLayout";
import { useAuth } from "@/hooks/useAuth";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { ErrorBoundary } from "@/components/app/ErrorBoundary";
import { PageSpinner } from "@/components/app/States";
import { firstPage } from "@/lib/firstPage";

// Pages other than the first ones (login, the Dashboard day: rendered on the server too) come with the
// rest of English, which the first load leaves out (contracts/i18n/client.ts) and fetches at start.
const withEnglish = <T,>(page: Promise<T>): Promise<T> => Promise.all([page, englishReady()]).then(([m]) => m);

const load = {
  login: () => import("@/pages/Login"),
  issue: () => withEnglish(import("@/pages/IssueRoute")),
  invite: () => withEnglish(import("@/pages/Invite")),
  changePassword: () => withEnglish(import("@/pages/ChangePassword")),
  dashboard: () => import("@/pages/Dashboard"),
  issues: () => withEnglish(import("@/pages/Issues")),
  desk: () => withEnglish(import("@/pages/DeskPage")),
  timesheet: () => withEnglish(import("@/pages/Timesheet")),
  board: () => withEnglish(import("@/pages/Board")),
  pinboard: () => withEnglish(import("@/pages/PinboardPage")),
  todos: () => withEnglish(import("@/pages/TodosPage")),
  notifications: () => withEnglish(import("@/pages/NotificationsPage")),
  ideas: () => withEnglish(import("@/pages/IdeasPage")),
  notes: () => withEnglish(import("@/pages/NotesPage")),
  reports: () => withEnglish(import("@/pages/Reports")),
  team: () => withEnglish(import("@/pages/Team")),
  settings: () => withEnglish(import("@/pages/Settings")),
  notFound: () => withEnglish(import("@/pages/NotFound")),
  info: () => withEnglish(import("@/pages/Info")),
  install: () => withEnglish(import("@/pages/Install")),
};

// The page asked for starts downloading at once, beside the session check (not after it): its
// chunk is the same one its route then renders (the module is fetched once).
const FIRST: [RegExp, keyof typeof load][] = [
  [/^\/$/, "dashboard"],
  [/^\/login\/?$/, "login"],
  [/^\/install\/?$/, "install"],
  [/^\/invite\//, "invite"],
  [/^\/issues\/?$/, "issues"],
  [/^\/issues\/desk\/?$/, "desk"],
  [/^\/issues\/.+/, "issue"],
  [/^\/timesheet/, "timesheet"],
  [/^\/board/, "board"],
  [/^\/pinboard/, "pinboard"],
  [/^\/todos/, "todos"],
  [/^\/notifications/, "notifications"],
  [/^\/ideas/, "ideas"],
  [/^\/notes/, "notes"],
  [/^\/reports/, "reports"],
  [/^\/team/, "team"],
  [/^\/settings/, "settings"],
  [/^\/info/, "info"],
];

/**
 * The app has taken the page over (<html data-live>): drawn beside the page, it commits with it
 * (hydrated, or loaded) inside whichever Suspense holds it, never with the shell before it.
 * What tests wait for before acting.
 */
function Live() {
  useEffect(() => {
    document.documentElement.dataset.live = "";
  }, []);
  return null;
}

/**
 * A page on demand. The first page's code is in before the app hydrates (main.tsx awaits
 * `firstPage`): that page draws at once, never suspended. Suspended, it kept the whole
 * server-drawn app without handlers (one Suspense holds the routes) and clicks there were
 * lost, for as long as a slow machine took to resolve it.
 */
function page(loader: () => Promise<ComponentType>) {
  let ready: ComponentType | null = null;
  // Decided at the first draw, once: switching later would remount a page on screen.
  let now: boolean | null = null;
  const loadPage = () => loader().then(c => (ready = c));
  const Lazy = lazy(() => loadPage().then(c => ({ default: c })));
  function Page() {
    now ??= ready !== null;
    const Ready = ready;
    return (
      <>
        {now && Ready ? <Ready /> : <Lazy />}
        <Live />
      </>
    );
  }
  return Object.assign(Page, { load: loadPage });
}

const Login = page(() => load.login().then(m => m.default));
const IssueByKey = page(() => load.issue().then(m => m.IssueByKey));
const IssueByRef = page(() => load.issue().then(m => m.IssueByRef));
const Invite = page(() => load.invite().then(m => m.default));
const ChangePassword = page(() => load.changePassword().then(m => m.default));
const Dashboard = page(() => load.dashboard().then(m => m.default));
const Issues = page(() => load.issues().then(m => m.default));
const DeskPage = page(() => load.desk().then(m => m.default));
const Timesheet = page(() => load.timesheet().then(m => m.default));
const Board = page(() => load.board().then(m => m.default));
const PinboardPage = page(() => load.pinboard().then(m => m.default));
const TodosPage = page(() => load.todos().then(m => m.default));
const NotificationsPage = page(() => load.notifications().then(m => m.default));
const IdeasPage = page(() => load.ideas().then(m => m.default));
const NotesPage = page(() => load.notes().then(m => m.default));
const Reports = page(() => load.reports().then(m => m.default));
const Team = page(() => load.team().then(m => m.default));
const Settings = page(() => load.settings().then(m => m.default));
const NotFound = page(() => load.notFound().then(m => m.default));
const Info = page(() => load.info().then(m => m.default));
const Install = page(() => load.install().then(m => m.default));

const PAGES: Record<keyof typeof load, { load: () => Promise<unknown> }[]> = {
  login: [Login],
  issue: [IssueByKey, IssueByRef],
  invite: [Invite],
  changePassword: [ChangePassword],
  dashboard: [Dashboard],
  issues: [Issues],
  desk: [DeskPage],
  timesheet: [Timesheet],
  board: [Board],
  pinboard: [PinboardPage],
  todos: [TodosPage],
  notifications: [NotificationsPage],
  ideas: [IdeasPage],
  notes: [NotesPage],
  reports: [Reports],
  team: [Team],
  settings: [Settings],
  notFound: [NotFound],
  info: [Info],
  install: [Install],
};

// The page asked for, downloading at once beside the session check (not after it), and the
// same code its route then draws.
if (typeof window !== "undefined") {
  const first = FIRST.find(([re]) => re.test(window.location.pathname))?.[1];
  firstPage.set(Promise.all((first ? PAGES[first] : []).map(p => p.load())));
}

/** auth.me failed (network, 5xx): keep the route and keep trying. */
function Reconnecting({
  onRetry,
  retrying,
}: {
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <div
      className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center"
      role="status"
    >
      <Spinner className="h-6 w-6 text-muted-foreground" aria-hidden />
      <p className="font-medium">{t("ui.app.reconnecting")}</p>
      <p className="max-w-xs text-body-sm text-muted-foreground">
        {t("ui.app.serverDown")}
      </p>
      <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
        {t("ui.app.retryNow")}
      </Button>
    </div>
  );
}

/**
 * Signed-in area: redirects to /login (remembering the target) only when
 * the server confirmed there is no session.
 */
function RequireAuth() {
  const { user, isLoading, isAuthenticated, isUnreachable, isRetrying, retry } =
    useAuth();
  const location = useLocation();
  if (isLoading) return <PageSpinner />;
  if (isUnreachable)
    return <Reconnecting onRetry={retry} retrying={isRetrying} />;
  if (!isAuthenticated) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname + location.search }}
      />
    );
  }
  // A default or temporary password: only its change, until it is done.
  if (user?.mustChangePassword) return <ChangePassword />;
  return <AppLayout />;
}

/** /login is only for signed-out users; signed in, go back where they were. */
function GuestOnly() {
  const { isLoading, isAuthenticated, isUnreachable, isRetrying, retry } =
    useAuth();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "/";
  if (isLoading) return <PageSpinner />;
  if (isUnreachable)
    return <Reconnecting onRetry={retry} retrying={isRetrying} />;
  return isAuthenticated ? <Navigate to={from} replace /> : <Outlet />;
}

export default function App() {
  const { pathname } = useLocation();
  // A new language redraws every text: the whole tree is keyed on it.
  const locale = useLocale();
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <ErrorBoundary key={locale} resetKey={pathname}>
        <Suspense fallback={<PageSpinner />}>
          <Routes>
            {/* Public: a new device opens it before any login. */}
            <Route path="/install" element={<Install />} />
            <Route path="/invite/:token" element={<Invite />} />
            <Route element={<GuestOnly />}>
              <Route path="/login" element={<Login />} />
            </Route>
            <Route element={<RequireAuth />}>
              <Route path="/" element={<Dashboard />} />
              <Route path="/issues" element={<ObservedPage surfaceId="issues"><Issues /></ObservedPage>} />
              <Route path="/issues/desk" element={<ObservedPage surfaceId="desk"><DeskPage /></ObservedPage>} />
              <Route path="/issues/:connectionId/:remoteId" element={<IssueByRef />} />
              <Route path="/issues/:key" element={<IssueByKey />} />
              <Route path="/timesheet" element={<ObservedPage surfaceId="timesheet"><Timesheet /></ObservedPage>} />
              <Route path="/board" element={<ObservedPage surfaceId="board"><Board /></ObservedPage>} />
              <Route path="/pinboard" element={<PinboardPage />} />
              <Route path="/todos" element={<TodosPage />} />
              <Route path="/notifications" element={<NotificationsPage />} />
              <Route path="/ideas" element={<IdeasPage />} />
              <Route path="/notes" element={<NotesPage />} />
              <Route path="/notes/new" element={<NotesPage />} />
              <Route path="/notes/trash" element={<NotesPage />} />
              <Route path="/notes/diary" element={<NotesPage />} />
              <Route path="/notes/:noteId" element={<NotesPage />} />
              <Route path="/reports" element={<ObservedPage surfaceId="reports"><Reports /></ObservedPage>} />
              <Route path="/team" element={<ObservedPage surfaceId="team"><Team /></ObservedPage>} />
              <Route path="/settings/:section?" element={<Settings />} />
              <Route path="/info" element={<Info />} />
              <Route path="/info/:tab" element={<Info />} />
              <Route path="/info/:tab/:id" element={<Info />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </Suspense>
      </ErrorBoundary>
      {/* Phones and tablets: above the tab bar (sonner's mobile layout stops at 600px). */}
      <Toaster
        position="bottom-right"
        offset={{ bottom: "max(24px, calc(var(--bottom-nav-h) + var(--dock-h, 0px) + 12px))" }}
        mobileOffset={{ bottom: "calc(var(--bottom-nav-h) + var(--dock-h, 0px) + 8px)" }}
      />
    </ThemeProvider>
  );
}
