/** Fill the fields of an AcroForm from a list (they can be found on the page from here too). */
import { Crosshair, ListChecks } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";
import { engine } from "../../../engine/client";
import type { FormField } from "../../../engine/types";
import { useStore } from "../../../store";
import { Button, Empty, IconButton } from "../controls";
import { errorText } from "../util";

const nameOf = (f: FormField) => f.label || f.name || "Unnamed field";

const set = (field: FormField, value: string | boolean) =>
  void useStore.getState().run("Filling field", () => engine.setFormField(field.page, field.id, value));

function Locate({ field }: { field: FormField }) {
  const scrollTo = useStore((s) => s.scrollTo);
  return (
    <IconButton
      icon={Crosshair}
      size={18}
      label={`Show ${nameOf(field)} on the page`}
      onClick={() => scrollTo(field.page, field.rect)}
    />
  );
}

function TextInput({ field }: { field: FormField }) {
  const id = useId();
  const [draft, setDraft] = useState(field.value);
  const latest = useRef(draft);
  const saved = useRef(field.value);
  latest.current = draft;
  const commit = () => {
    if (latest.current === saved.current) return;
    saved.current = latest.current;
    set(field, latest.current);
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;
  // closing the panel must not lose what was typed
  useEffect(() => () => commitRef.current(), []);
  const common = {
    id,
    className: "sh-input",
    name: field.name,
    dir: "auto" as const,
    autoComplete: "off",
    value: draft,
    disabled: field.readOnly,
    onBlur: commit,
  };
  return (
    <div className="sh-field">
      <label className="sh-label" htmlFor={id}>
        {nameOf(field)}
      </label>
      <div className="sh-input-group">
        {field.multiline ? (
          <textarea {...common} rows={3} onChange={(e) => setDraft(e.target.value)} />
        ) : (
          <input
            {...common}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) commit();
            }}
          />
        )}
        <Locate field={field} />
      </div>
    </div>
  );
}

function Choice({ field }: { field: FormField }) {
  const id = useId();
  const options = field.options ?? [];
  return (
    <div className="sh-field">
      <label className="sh-label" htmlFor={id}>
        {nameOf(field)}
      </label>
      <div className="sh-input-group">
        <select
          id={id}
          className="sh-input"
          name={field.name}
          disabled={field.readOnly}
          value={field.value}
          onChange={(e) => set(field, e.target.value)}
        >
          {!options.includes(field.value) && <option value={field.value}>{field.value || "Choose…"}</option>}
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <Locate field={field} />
      </div>
    </div>
  );
}

function Toggle({ field }: { field: FormField }) {
  return (
    <div className="sh-input-group">
      <label className="sh-check">
        <input
          type="checkbox"
          name={field.name}
          checked={!!field.checked}
          disabled={field.readOnly}
          onChange={(e) => set(field, e.target.checked)}
        />
        <span>{nameOf(field)}</span>
      </label>
      <Locate field={field} />
    </div>
  );
}

function Radios({ fields }: { fields: FormField[] }) {
  const first = fields[0]!;
  const group = useId();
  // either one widget per choice, or a single field listing its choices
  const single = fields.length === 1 && (first.options?.length ?? 0) > 1;
  const choices = single
    ? first.options!.map((o) => ({ key: o, label: o, field: first, value: o as string | boolean, checked: first.value === o }))
    : fields.map((f, i) => ({
        key: f.id,
        label: f.options?.[fields.length === f.options.length ? i : 0] ?? `Option ${i + 1}`,
        field: f,
        value: true as string | boolean,
        checked: !!f.checked,
      }));
  return (
    <fieldset className="sh-fieldset">
      <legend className="sh-label">{nameOf(first)}</legend>
      {choices.map((c) => (
        <div className="sh-input-group" key={c.key}>
          <label className="sh-check">
            <input
              type="radio"
              name={group}
              checked={c.checked}
              disabled={c.field.readOnly}
              onChange={() => set(c.field, c.value)}
            />
            <span>{c.label}</span>
          </label>
          <Locate field={c.field} />
        </div>
      ))}
    </fieldset>
  );
}

export function FormsPanel() {
  const version = useStore((s) => s.doc!.pages.map((p) => p.revision).join(","));
  const openPanel = useStore((s) => s.openPanel);
  const [fields, setFields] = useState<FormField[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    engine.listFormFields().then(
      (list) => {
        if (!live) return;
        setFields(list);
        setError("");
      },
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [version]);

  if (error) return <Empty icon={ListChecks} title="The form could not be read"><p>{error}</p></Empty>;
  if (!fields) return <p className="sh-status sh-pad" role="status">Reading fields…</p>;
  const shown = fields.filter((f) => f.type !== "button");
  if (!shown.length)
    return (
      <Empty icon={ListChecks} title="No form fields">
        <p>This PDF has no fillable fields. Use Add text to write on the page.</p>
        <Button
          onClick={() => {
            openPanel(null);
            useStore.getState().setTool("add-text");
          }}
        >
          Add text
        </Button>
      </Empty>
    );

  const radios = new Map<string, FormField[]>();
  for (const f of shown) if (f.type === "radio") radios.set(f.name, [...(radios.get(f.name) ?? []), f]);

  let page = -1;
  return (
    <div className="sh-scroll">
      <div className="sh-stack sh-pad">
        {shown.map((field, index) => {
          const key = `${field.page}:${field.name}:${index}`;
          if (field.type === "radio" && radios.get(field.name)![0] !== field) return null;
          const heading = field.page !== page ? <h3>Page {(page = field.page) + 1}</h3> : null;
          return (
            <div className="sh-stack" key={key}>
              {heading}
              {field.type === "text" ? (
                <TextInput key={field.value} field={field} />
              ) : field.type === "checkbox" ? (
                <Toggle field={field} />
              ) : field.type === "radio" ? (
                <Radios fields={radios.get(field.name)!} />
              ) : field.type === "combobox" || field.type === "listbox" ? (
                <Choice field={field} />
              ) : (
                <div className="sh-input-group">
                  <p className="sh-grow">
                    {nameOf(field)}
                    <br />
                    <small className="sh-hint">Signature field. Use Sign to place a drawn signature.</small>
                  </p>
                  <Locate field={field} />
                </div>
              )}
            </div>
          );
        })}
        <p className="sh-hint">To make the answers permanent, turn on “Flatten” in download options.</p>
        <Button onClick={() => openPanel("export")} block>
          Download options
        </Button>
      </div>
    </div>
  );
}
