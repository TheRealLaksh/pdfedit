/** Modal dialogs: document password, confirmations and one-field prompts. */
import { LockKey } from "@phosphor-icons/react";
import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useStore } from "../../store";
import { Button, PasswordField, Field } from "./controls";
import { useDialog } from "./hooks";
import { useShell, type PromptRequest } from "./uiStore";

export function Modal(props: { title: string; children: ReactNode; onClose(): void; icon?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useDialog(ref, { modal: true, onClose: props.onClose });
  return (
    <div className="sh-modal">
      <div className="sh-scrim" onClick={props.onClose} />
      <div ref={ref} className="sh-dialog" role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}>
        <h2 id={id} className="sh-dialog-title">
          {props.icon}
          {props.title}
        </h2>
        {props.children}
      </div>
    </div>
  );
}

function PasswordDialog() {
  const request = useStore((s) => s.passwordPrompt)!;
  const submit = useStore((s) => s.submitPassword);
  const cancel = useStore((s) => s.cancelPassword);
  const [password, setPassword] = useState("");
  const send = (e: FormEvent) => {
    e.preventDefault();
    if (password) void submit(password);
  };
  return (
    <Modal title="Password needed" onClose={cancel} icon={<LockKey size={22} aria-hidden />}>
      <form onSubmit={send} className="sh-stack">
        <p className="sh-break">
          <strong>{request.fileName}</strong> is protected. The password stays on this device.
        </p>
        <PasswordField
          label="Password"
          value={password}
          onChange={setPassword}
          autoFocus
          error={request.wrong ? "That password did not work. Try again." : undefined}
        />
        <div className="sh-actions">
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!password}>
            Open
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function PromptDialog({ request }: { request: PromptRequest }) {
  const [value, setValue] = useState("");
  const cancel = () => request.resolve(null);
  const send = (e: FormEvent) => {
    e.preventDefault();
    if (value) request.resolve(value);
  };
  return (
    <Modal title={request.title} onClose={cancel}>
      <form onSubmit={send} className="sh-stack">
        <p className="sh-break">{request.message}</p>
        {request.type === "password" ? (
          <PasswordField label={request.label} value={value} onChange={setValue} autoFocus />
        ) : (
          <Field label={request.label} value={value} onChange={(e) => setValue(e.target.value)} data-autofocus />
        )}
        <div className="sh-actions">
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!value}>
            {request.submit}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function Dialogs() {
  const password = useStore((s) => s.passwordPrompt);
  const confirm = useShell((s) => s.confirm);
  const prompt = useShell((s) => s.prompt);
  return (
    <>
      {password && <PasswordDialog key={`${password.fileName}:${password.wrong}`} />}
      {confirm && (
        <Modal title={confirm.title} onClose={() => confirm.resolve(null)}>
          <div className="sh-stack">
            <p className="sh-break">{confirm.message}</p>
            <div className="sh-actions">
              {confirm.choices.map((c) => (
                <Button
                  key={c.id}
                  variant={c.tone === "primary" ? "primary" : c.tone === "danger" ? "danger" : "ghost"}
                  onClick={() => confirm.resolve(c.id)}
                  data-autofocus={c.tone === "primary" || undefined}
                >
                  {c.label}
                </Button>
              ))}
            </div>
          </div>
        </Modal>
      )}
      {prompt && <PromptDialog key={prompt.message} request={prompt} />}
    </>
  );
}
