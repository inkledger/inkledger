import { lazy, Suspense } from "react";
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router";
import { t, useLocale } from "@/i18n";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { AppLayout } from "@/components/AppLayout";
import { useAuth } from "@/hooks/useAuth";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { ErrorBoundary } from "@/components/app/ErrorBoundary";
import { PageSpinner } from "@/components/app/States";

const load = {
  login: () => import("@/pages/Login"),
  issue: () => import("@/pages/IssueRoute"),
  invite: () => import("@/pages/Invite"),
  changePassword: () => import("@/pages/ChangePassword"),
  dashboard: () => import("@/pages/Dashboard"),
  issues: () => import("@/pages/Issues"),
  timesheet: () => import("@/pages/Timesheet"),
  board: () => import("@/pages/Board"),
  pinboard: () => import("@/pages/PinboardPage"),
  todos: () => import("@/pages/TodosPage"),
  reports: () => import("@/pages/Reports"),
  settings: () => import("@/pages/Settings"),
  notFound: () => import("@/pages/NotFound"),
  info: () => import("@/pages/Info"),
  install: () => import("@/pages/Install"),
};

// The page asked for starts downloading at once, beside the session check (not after it): its
// chunk is the same one its route then renders (the module is fetched once).
const FIRST: [RegExp, keyof typeof load][] = [
  [/^\/$/, "dashboard"],
  [/^\/login\/?$/, "login"],
  [/^\/install\/?$/, "install"],
  [/^\/invite\//, "invite"],
  [/^\/issues\/?$/, "issues"],
  [/^\/issues\/.+/, "issue"],
  [/^\/timesheet/, "timesheet"],
  [/^\/board/, "board"],
  [/^\/pinboard/, "pinboard"],
  [/^\/todos/, "todos"],
  [/^\/reports/, "reports"],
  [/^\/settings/, "settings"],
  [/^\/info/, "info"],
];
if (typeof window !== "undefined") {
  const first = FIRST.find(([re]) => re.test(window.location.pathname))?.[1];
  if (first) void load[first]().catch(() => undefined);
}

const Login = lazy(load.login);
const IssueByKey = lazy(() => load.issue().then(m => ({ default: m.IssueByKey })));
const IssueByRef = lazy(() => load.issue().then(m => ({ default: m.IssueByRef })));
const Invite = lazy(load.invite);
const ChangePassword = lazy(load.changePassword);
const Dashboard = lazy(load.dashboard);
const Issues = lazy(load.issues);
const Timesheet = lazy(load.timesheet);
const Board = lazy(load.board);
const PinboardPage = lazy(load.pinboard);
const TodosPage = lazy(load.todos);
const Reports = lazy(load.reports);
const Settings = lazy(load.settings);
const NotFound = lazy(load.notFound);
const Info = lazy(load.info);
const Install = lazy(load.install);

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
              <Route path="/issues" element={<Issues />} />
              <Route path="/issues/:connectionId/:remoteId" element={<IssueByRef />} />
              <Route path="/issues/:key" element={<IssueByKey />} />
              <Route path="/timesheet" element={<Timesheet />} />
              <Route path="/board" element={<Board />} />
              <Route path="/pinboard" element={<PinboardPage />} />
              <Route path="/todos" element={<TodosPage />} />
              <Route path="/reports" element={<Reports />} />
              <Route path="/settings/:section?" element={<Settings />} />
              <Route path="/info" element={<Info />} />
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
