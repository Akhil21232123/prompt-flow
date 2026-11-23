import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  ClipboardPaste,
  Copy,
  History as HistoryIcon,
  Loader2,
  Search,
} from "lucide-react";
import { commands } from "@/bindings";
import type { CloudDictation } from "@/bindings";
import { apiErrorMessage, useAccount } from "@/lib/cloud";
import { copyToClipboard } from "../history/clipboard";
import { PfBadge, PfPage } from "./ui";

const PAGE = 50;

/** Your dictations from every device, newest first. */
export const CloudHistory: React.FC = () => {
  const { t, i18n } = useTranslation();
  const account = useAccount();
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<CloudDictation[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const request = useRef(0);

  const load = useCallback(
    async (q: string, offset: number) => {
      const mine = ++request.current;
      const r = await commands.cloudHistory(offset, q);
      if (mine !== request.current) return;
      if (r.status === "ok") {
        setRows((prev) =>
          offset === 0 ? r.data : [...(prev ?? []), ...r.data],
        );
        setMore(r.data.length === PAGE);
        setError(null);
      } else {
        setError(apiErrorMessage(t, r.error));
        setRows((prev) => prev ?? []);
      }
    },
    [t],
  );

  // Search as you type, a beat after the last key.
  useEffect(() => {
    if (!account.signedIn) return;
    const timer = setTimeout(() => void load(query, 0), query ? 300 : 0);
    return () => clearTimeout(timer);
  }, [query, account.signedIn, load]);

  const when = (iso: string) => {
    const d = new Date(iso);
    return isNaN(d.getTime())
      ? ""
      : d.toLocaleString(i18n.language, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
  };

  return (
    <PfPage
      title={t("cloudHistory.title")}
      subtitle={t("cloudHistory.subtitle")}
    >
      {!account.signedIn ? (
        <div className="pf-card p-6 text-[14px] text-pf-muted">
          {t("cloudHistory.signInFirst")}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 rounded-xl bg-pf-surface border border-pf-border focus-within:border-pf-violet transition-colors px-3">
            <Search size={15} className="text-pf-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("cloudHistory.search")}
              className="flex-1 bg-transparent py-2.5 text-[14px] text-pf-text outline-none placeholder:text-pf-muted/70"
            />
          </div>
          {error && (
            <p
              role="alert"
              className="text-[13px] text-pf-red bg-pf-red/10 border border-pf-red/20 rounded-xl px-3 py-2"
            >
              {error}
            </p>
          )}
          {rows === null ? (
            <div className="flex justify-center py-10 text-pf-muted">
              <Loader2 className="animate-spin" />
            </div>
          ) : rows.length === 0 ? (
            <div className="pf-card p-8 flex flex-col items-center text-center gap-2">
              <div className="w-11 h-11 rounded-2xl bg-pf-violet/15 text-pf-violet flex items-center justify-center">
                <HistoryIcon size={20} />
              </div>
              <div className="text-[15px] font-semibold text-pf-text">
                {query ? t("cloudHistory.noMatch") : t("cloudHistory.empty")}
              </div>
            </div>
          ) : (
            <div className="pf-card divide-y divide-pf-border">
              {rows.map((row) => (
                <Row key={row.id} row={row} when={when(row.created_at)} />
              ))}
            </div>
          )}
          {more && (
            <button
              className="pf-button-secondary self-center h-9 px-4"
              disabled={loadingMore}
              onClick={async () => {
                setLoadingMore(true);
                await load(query, rows?.length ?? 0);
                setLoadingMore(false);
              }}
            >
              {loadingMore && <Loader2 size={14} className="animate-spin" />}
              {t("cloudHistory.more")}
            </button>
          )}
        </>
      )}
    </PfPage>
  );
};

const Row: React.FC<{ row: CloudDictation; when: string }> = ({
  row,
  when,
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const isPrompt = row.mode === "engineer";
  const showRaw =
    row.raw_text.trim() && row.raw_text.trim() !== row.final_text.trim();
  return (
    <div className="group px-4 py-3 flex gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap mb-1">
          <PfBadge tone={isPrompt ? "blue" : "violet"}>
            {t(`cloudHistory.mode.${row.mode}`, row.mode)}
          </PfBadge>
          {row.app_name && <PfBadge>{row.app_name}</PfBadge>}
          <span className="text-[11.5px] text-pf-muted">{when}</span>
          {row.label && (
            <span className="text-[11.5px] text-pf-muted truncate">
              {row.label}
            </span>
          )}
        </div>
        <button
          className="text-start w-full cursor-pointer"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <p
            className={`text-[13.5px] text-pf-text leading-snug whitespace-pre-wrap break-words ${
              open ? "" : "line-clamp-3"
            }`}
          >
            {row.final_text}
          </p>
        </button>
        {open && showRaw && (
          <div className="mt-2 rounded-lg bg-pf-surface-2 px-3 py-2 pf-rise">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-pf-muted mb-0.5">
              {t("cloudHistory.youSaid")}
            </div>
            <p className="text-[12.5px] text-pf-muted leading-snug whitespace-pre-wrap">
              {row.raw_text}
            </p>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1 opacity-70 group-hover:opacity-100 transition-opacity">
        <button
          className="w-8 h-8 rounded-lg flex items-center justify-center text-pf-muted hover:text-pf-text hover:bg-pf-surface-2 cursor-pointer"
          title={t("common.copy")}
          aria-label={t("common.copy")}
          onClick={async () => {
            if (await copyToClipboard(row.final_text)) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }
          }}
        >
          {copied ? <Check size={15} /> : <Copy size={15} />}
        </button>
        <button
          className="w-8 h-8 rounded-lg flex items-center justify-center text-pf-muted hover:text-pf-text hover:bg-pf-surface-2 cursor-pointer"
          title={t("cloudHistory.pasteAgain")}
          aria-label={t("cloudHistory.pasteAgain")}
          onClick={() => void commands.pasteAgain(row.final_text)}
        >
          <ClipboardPaste size={15} />
        </button>
      </div>
    </div>
  );
};
