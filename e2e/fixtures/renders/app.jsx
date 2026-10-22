// The renders counter's fixture: work known in advance. A ticker commits once a second and
// re-renders its plain child; its memo child and a static sibling never render again.
import { memo, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

const Leaf = memo(function Leaf() {
  return <span data-testid="memo-leaf">leaf</span>;
});

function Plain({ n }) {
  return <span data-testid="plain-child">{n}</span>;
}

function Ticker() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const i = setInterval(() => setN(x => x + 1), 1000);
    return () => clearInterval(i);
  }, []);
  return (
    <div data-testid="ticker">
      <Plain n={n} />
      <Leaf />
    </div>
  );
}

function Static() {
  return <p data-testid="static">static</p>;
}

createRoot(document.getElementById("root")).render(
  <>
    <Ticker />
    <Static />
  </>,
);
