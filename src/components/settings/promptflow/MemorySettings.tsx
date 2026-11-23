import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Brain,
  Check,
  Loader2,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { commands } from "@/bindings";
import type { Memory } from "@/bindings";
import { apiErrorMessage, useAccount } from "@/lib/cloud";
import { PfBadge, PfCard, PfPage, PfToggleRow } from "./ui";
import { useFlow } from "./useFlow";

const KINDS = ["fact", "preference", "project", "person"] as const;
const MAX = 280;

export const MemorySettings: React.FC = () => {
  const { t } = useTranslation();
  const account = useAccount();
  const f = useFlow();
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftKind, setDraftKind] = useState<string>("fact");
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await commands.memoriesList();
    if (r.status === "ok") {
      setMemories(r.data);
      setError(null);
    } else {
      setError(apiErrorMessage(t, r.error));
      setMemories((m) => m ?? []);
    }
  }, [t]);

  useEffect(() => {
    if (account.signedIn) void load();
  }, [account.signedIn, load]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = memories ?? [];
    return q ? list.filter((m) => m.content.toLowerCase().includes(q)) : list;
  }, [memories, query]);

  const replace = (m: Memory) =>
    setMemories((list) =>
      (list ?? [])
        .map((x) => (x.id === m.id ? m : x))
        .sort((a, b) => Number(b.pinned) - Number(a.pinned)),
    );

  const add = async () => {
    if (!draft.trim()) return;
    setBusyId("new");
    const r = await commands.memoryAdd(draft.trim(), draftKind);
    setBusyId(null);
    if (r.status === "ok") {
      setMemories((list) => [r.data, ...(list ?? [])]);
      setDraft("");
      setAdding(false);
      setError(null);
    } else setError(apiErrorMessage(t, r.error));
  };

  const togglePin = async (m: Memory) => {
    setBusyId(m.id);
    const r = await commands.memoryUpdate(m.id, null, null, !m.pinned);
    setBusyId(null);
    if (r.status === "ok") replace(r.data);
    else setError(apiErrorMessage(t, r.error));
  };

  const saveEdit = async (m: Memory) => {
    const text = editText.trim();
    if (!text || text === m.content) {
      setEditing(null);
      return;
    }
    setBusyId(m.id);
    const r = await commands.memoryUpdate(m.id, text, null, null);
    setBusyId(null);
    if (r.status === "ok") {
      replace(r.data);
      setEditing(null);
    } else setError(apiErrorMessage(t, r.error));
  };

  const remove = async (m: Memory) => {
    setBusyId(m.id);
    const r = await commands.memoryDelete(m.id);
    setBusyId(null);
    setConfirmDelete(null);
    if (r.status === "ok")
      setMemories((list) => (list ?? []).filter((x) => x.id !== m.id));
    else setError(apiErrorMessage(t, r.error));
  };

  const addButton = account.signedIn && (
    <button className="pf-button-primary small" onClick={() => setAdding(true)}>
      <Plus size={15} />
      {t("memory.add")}
    </button>
  );

  return (
    <PfPage
      title={t("memory.title")}
      subtitle={t("memory.subtitle")}
      action={addButton}
    >
      <PfCard>
        <PfToggleRow
          id="pf-memory-enabled"
          title={t("memory.enabled")}
          description={t("memory.enabledDescription")}
          checked={f.memoryEnabled}
          onChange={(v) => f.save({ memory_enabled: v })}
        />
      </PfCard>

      {!account.signedIn ? (
        <div className="pf-card p-6 text-[14px] text-pf-muted">
          {t("memory.signInFirst")}
        </div>
      ) : (
        <>
          {adding && (
            <div className="pf-card p-4 flex flex-col gap-3 pf-rise">
              <textarea
                autoFocus
                value={draft}
                maxLength={MAX}
                rows={2}
                placeholder={t("memory.addPlaceholder")}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void add();
                  } else if (e.key === "Escape") setAdding(false);
                }}
                className="w-full rounded-xl bg-pf-surface-2 border border-pf-border focus:border-pf-violet outline-none p-3 text-[14px] text-pf-text placeholder:text-pf-muted/70 resize-none"
              />
              <div className="flex items-center gap-2 flex-wrap">
                {KINDS.map((k) => (
                  <button
                    key={k}
                    onClick={() => setDraftKind(k)}
                    className={`h-7 px-3 rounded-full text-[12px] font-medium border transition-colors cursor-pointer ${
                      draftKind === k
                        ? "border-pf-violet bg-pf-violet/15 text-pf-text"
                        : "border-pf-border text-pf-muted hover:text-pf-text"
                    }`}
                  >
                    {t(`memory.kinds.${k}`)}
                  </button>
                ))}
                <span className="flex-1" />
                <span className="text-[11.5px] text-pf-muted tabular-nums">
                  {t("memory.count", { n: draft.length, max: MAX })}
                </span>
                <button
                  className="pf-button-secondary"
                  onClick={() => setAdding(false)}
                >
                  {t("common.cancel")}
                </button>
                <button
                  className="pf-button-primary small"
                  disabled={!draft.trim() || busyId === "new"}
                  onClick={() => void add()}
                >
                  {busyId === "new" && (
                    <Loader2 size={14} className="animate-spin" />
                  )}
                  {t("common.save")}
                </button>
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 rounded-xl bg-pf-surface border border-pf-border focus-within:border-pf-violet transition-colors px-3">
            <Search size={15} className="text-pf-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("memory.search")}
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

          {memories === null ? (
            <div className="flex justify-center py-10 text-pf-muted">
              <Loader2 className="animate-spin" />
            </div>
          ) : shown.length === 0 ? (
            <div className="pf-card p-8 flex flex-col items-center text-center gap-2">
              <div className="w-11 h-11 rounded-2xl bg-pf-violet/15 text-pf-violet flex items-center justify-center">
                <Brain size={20} />
              </div>
              <div className="text-[15px] font-semibold text-pf-text">
                {query ? t("memory.noMatch") : t("memory.emptyTitle")}
              </div>
              {!query && (
                <p className="text-[13px] text-pf-muted max-w-sm">
                  {t("memory.emptyBody")}
                </p>
              )}
            </div>
          ) : (
            <div className="pf-card divide-y divide-pf-border">
              {shown.map((m) => (
                <div
                  key={m.id}
                  className="group px-4 py-3 flex items-start gap-3"
                >
                  <div className="flex-1 min-w-0">
                    {editing === m.id ? (
                      <textarea
                        autoFocus
                        value={editText}
                        maxLength={MAX}
                        rows={2}
                        onChange={(e) => setEditText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            void saveEdit(m);
                          } else if (e.key === "Escape") setEditing(null);
                        }}
                        className="w-full rounded-lg bg-pf-surface-2 border border-pf-violet outline-none p-2 text-[14px] text-pf-text resize-none"
                      />
                    ) : (
                      <p className="text-[14px] text-pf-text leading-snug break-words">
                        {m.content}
                      </p>
                    )}
                    <div className="flex items-center gap-1.5 mt-1.5">
                      {m.pinned && (
                        <PfBadge tone="violet">
                          <Pin size={10} />
                          {t("memory.pinned")}
                        </PfBadge>
                      )}
                      <PfBadge>{t(`memory.kinds.${m.kind}`, m.kind)}</PfBadge>
                      <span className="text-[11.5px] text-pf-muted">
                        {m.source === "auto"
                          ? t("memory.learned")
                          : t("memory.addedByYou")}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-0.5 opacity-70 group-hover:opacity-100 transition-opacity">
                    {busyId === m.id ? (
                      <Loader2
                        size={15}
                        className="animate-spin text-pf-muted m-2"
                      />
                    ) : editing === m.id ? (
                      <>
                        <IconButton
                          label={t("common.save")}
                          onClick={() => void saveEdit(m)}
                        >
                          <Check size={15} />
                        </IconButton>
                        <IconButton
                          label={t("common.cancel")}
                          onClick={() => setEditing(null)}
                        >
                          <X size={15} />
                        </IconButton>
                      </>
                    ) : confirmDelete === m.id ? (
                      <>
                        <button
                          className="pf-button-danger small"
                          onClick={() => void remove(m)}
                        >
                          {t("memory.confirmDelete")}
                        </button>
                        <IconButton
                          label={t("common.cancel")}
                          onClick={() => setConfirmDelete(null)}
                        >
                          <X size={15} />
                        </IconButton>
                      </>
                    ) : (
                      <>
                        <IconButton
                          label={m.pinned ? t("memory.unpin") : t("memory.pin")}
                          onClick={() => void togglePin(m)}
                        >
                          {m.pinned ? <PinOff size={15} /> : <Pin size={15} />}
                        </IconButton>
                        <IconButton
                          label={t("common.edit")}
                          onClick={() => {
                            setEditing(m.id);
                            setEditText(m.content);
                          }}
                        >
                          <Pencil size={15} />
                        </IconButton>
                        <IconButton
                          label={t("common.delete")}
                          onClick={() => setConfirmDelete(m.id)}
                        >
                          <Trash2 size={15} />
                        </IconButton>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="text-[12px] text-pf-muted px-1">
            {t("memory.privacy")}
          </p>
        </>
      )}
    </PfPage>
  );
};

const IconButton: React.FC<{
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ label, onClick, children }) => (
  <button
    aria-label={label}
    title={label}
    onClick={onClick}
    className="w-8 h-8 rounded-lg flex items-center justify-center text-pf-muted hover:text-pf-text hover:bg-pf-surface-2 transition-colors cursor-pointer"
  >
    {children}
  </button>
);
