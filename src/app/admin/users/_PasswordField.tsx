"use client";

import { useState } from "react";
import { Eye, EyeOff, Sparkles, Copy, Check } from "lucide-react";

interface Props {
  name: string;
  label: string;
  required?: boolean;
  autoComplete?: string;
}

function generatePassword(length: number): string {
  const alphabet =
    "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*";
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

export function PasswordField({ name, label, required, autoComplete }: Props): React.JSX.Element {
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);

  const onSuggest = (): void => {
    const next = generatePassword(20);
    setValue(next);
    setShow(true);
  };

  const onCopy = async (): Promise<void> => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be blocked in some browsers — silently no-op.
    }
  };

  return (
    <label className="block">
      <span className="text-xs text-text-muted uppercase tracking-wider">{label}</span>
      <div className="mt-1 flex items-stretch gap-2">
        <div className="relative flex-1">
          <input
            name={name}
            type={show ? "text" : "password"}
            autoComplete={autoComplete}
            required={required}
            minLength={8}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-full rounded-lg bg-bg-card border border-line px-3 py-2 pr-9 text-sm font-mono focus:outline-none focus:border-rose-accent"
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-text-muted hover:text-text transition cursor-pointer"
            aria-label={show ? "Hide password" : "Show password"}
          >
            {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
        <button
          type="button"
          onClick={onSuggest}
          className="inline-flex items-center gap-1.5 rounded-lg bg-bg-card hover:bg-white/10 border border-line px-3 text-xs transition cursor-pointer"
          title="Generate a strong random password"
        >
          <Sparkles className="size-3.5" />
          Suggest
        </button>
        <button
          type="button"
          onClick={onCopy}
          disabled={!value}
          className="inline-flex items-center gap-1.5 rounded-lg bg-bg-card hover:bg-white/10 border border-line px-3 text-xs transition cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
          title="Copy to clipboard"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="mt-1 text-[11px] text-text-muted">
        Minimum 8 characters. The suggested password is 20 chars and uses a safe alphabet.
      </p>
    </label>
  );
}
