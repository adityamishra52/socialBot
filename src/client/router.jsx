import { Link as TanLink, useNavigate, useRouterState } from "@tanstack/react-router";

// The pages were written against a tiny router with { path, navigate } and <Link to>.
// These are the same names on top of TanStack Router, so every page uses TanStack navigation.
export function RouterProvider({ children }) {
  return children;
}

export function useRouter() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  const go = useNavigate();
  function navigate(to, { replace = false } = {}) {
    go({ to, replace });
    if (typeof window !== "undefined") window.scrollTo(0, 0);
  }
  return { path, navigate };
}

export function Link({ to, children, ...props }) {
  return (
    <TanLink to={to} {...props}>
      {children}
    </TanLink>
  );
}
