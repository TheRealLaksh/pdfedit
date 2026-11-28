/** Find and replace across the document. */
import { CaretDown, CaretUp } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { engine } from "../../../engine/client";
import type { FindMatch } from "../../../engine/types";
import { useStore } from "../../../store";
import { Button, Check, IconButton } from "../controls";
import { useDesktop } from "../hooks";
import { quadToRect } from "../../../engine/geom";
import { errorText } from "../util";

const LIST_LIMIT = 200;

function Context({ match, query }: { match: FindMatch; query: string }) {
  const at = match.context.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (at < 0) return <>{match.context}</>;
  return (
    <>
      {match.context.slice(0, at)}
      <mark>{match.context.slice(at, at + query.length)}</mark>
      {match.context.slice(at + query.length)}
    </>
  );
}

export function FindPanel() {
  const { query, matches, active } = useStore((s) => s.search);
  const setSearch = useStore((s) => s.setSearch);
  const scrollTo = useStore((s) => s.scrollTo);
  const run = useStore((s) => s.run);
  const busy = useStore((s) => s.busy !== null);
  // any change to any page means the results are stale
  const version = useStore((s) => s.doc!.pages.map((p) => p.revision).join(","));
  const desktop = useDesktop();
  const [replacement, setReplacement] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);

  const show = (index: number, list: FindMatch[] = matches) => {
    const match = list[index];
    if (!match) return;
    setSearch({ active: index });
    scrollTo(match.page, match.quads[0] ? quadToRect(match.quads[0]) : undefined);
  };

  // leaving the panel removes the highlights
  useEffect(() => () => useStore.getState().setSearch({ matches: [], active: -1 }), []);

  useEffect(() => {
    const id = ++sequence.current;
    setError("");
    if (!query) {
      setSearching(false);
      setSearch({ matches: [], active: -1 });
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const found = await engine.findText(query, { matchCase, wholeWord });
        if (id !== sequence.current) return;
        setSearch({ matches: found, active: -1 });
        const from = useStore.getState().currentPage;
        const first = found.findIndex((m) => m.page >= from);
        if (found.length) show(first < 0 ? 0 : first, found);
      } catch (e) {
        if (id === sequence.current) {
          setSearch({ matches: [], active: -1 });
          setError(errorText(e));
        }
      } finally {
        if (id === sequence.current) setSearching(false);
      }
    }, 350);
    return () => clearTimeout(timer);
    // show/setSearch are stable enough; re-running on them would repeat the search
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, matchCase, wholeWord, version]);

  const step = (by: number) => {
    if (matches.length) show((Math.max(active, by > 0 ? -1 : 0) + by + matches.length) % matches.length);
  };

  const replace = async (only?: FindMatch) => {
    const result = await run("Replacing", () =>
      engine.replaceText(query, replacement, { matchCase, wholeWord }, only ? [only] : undefined),
    );
    if (!result) return;
    const n = result.count ?? (only ? 1 : 0);
    useStore.getState().toast(`Replaced ${n} ${n === 1 ? "match" : "matches"}`, "success");
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    step(1);
  };

  const status = error
    ? error
    : !query
      ? ""
      : searching
        ? "Searching…"
        : matches.length
          ? `${active + 1} of ${matches.length}`
          : "No matches";

  const list = (
    <ol className="sh-results">
      {matches.slice(0, LIST_LIMIT).map((m, i) => (
        <li key={`${m.page}:${m.lineId}:${m.start}`}>
          <button type="button" aria-current={i === active || undefined} onClick={() => show(i)}>
            <small>Page {m.page + 1}</small>
            <span dir="auto">
              <Context match={m} query={query} />
            </span>
          </button>
        </li>
      ))}
      {matches.length > LIST_LIMIT && <li className="sh-hint sh-pad">And {matches.length - LIST_LIMIT} more.</li>}
    </ol>
  );

  return (
    <div className="sh-scroll sh-find">
      <div className="sh-stack sh-pad">
        <form className="sh-input-group" onSubmit={submit} role="search">
          <input
            ref={input}
            data-autofocus
            className="sh-input"
            type="search"
            name="find"
            dir="auto"
            aria-label="Find"
            placeholder="Find…"
            autoComplete="off"
            enterKeyHint="search"
            value={query}
            onChange={(e) => setSearch({ query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.shiftKey) {
                e.preventDefault();
                step(-1);
              }
            }}
          />
          <IconButton icon={CaretUp} label="Previous match" disabled={!matches.length} onClick={() => step(-1)} />
          <IconButton icon={CaretDown} label="Next match" disabled={!matches.length} onClick={() => step(1)} />
        </form>

        <p className={error ? "sh-error" : "sh-status"} role="status">
          {status}
        </p>

        <div className="sh-input-group">
          <input
            className="sh-input"
            name="replace"
            dir="auto"
            aria-label="Replace with"
            placeholder="Replace with…"
            autoComplete="off"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
          />
          <Button disabled={busy || searching || !matches[active]} onClick={() => void replace(matches[active])}>
            Replace
          </Button>
          <Button disabled={busy || searching || !matches.length} onClick={() => void replace()}>
            All
          </Button>
        </div>

        <div className="sh-row">
          <Check label="Match case" checked={matchCase} onChange={setMatchCase} />
          <Check label="Whole word" checked={wholeWord} onChange={setWholeWord} />
        </div>
      </div>
      {matches.length > 0 &&
        (desktop ? (
          list
        ) : (
          <details className="sh-details">
            <summary>Show all results</summary>
            {list}
          </details>
        ))}
    </div>
  );
}
