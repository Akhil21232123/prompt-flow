import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LogOut, RefreshCw, Trash2, UserRound } from "lucide-react";
import { commands } from "@/bindings";
import type { Usage } from "@/bindings";
import { Dialog } from "@/components/ui/Dialog";
import { SignIn } from "@/components/account/SignIn";
import { apiErrorMessage, useAccount } from "@/lib/cloud";
import { useSettings } from "@/hooks/useSettings";
import { PfBadge, PfCard, PfPage, PfRow } from "./ui";

export const AccountSettings: React.FC = () => {
  const { t } = useTranslation();
  const account = useAccount();
  const { getSetting } = useSettings();
  const privateMode = getSetting("flow")?.private_mode ?? false;
  const [usage, setUsage] = useState<Usage | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [loadingUsage, setLoadingUsage] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const loadUsage = useCallback(async () => {
    setLoadingUsage(true);
    const r = await commands.accountUsage();
    setLoadingUsage(false);
    if (r.status === "ok") {
      setUsage(r.data);
      setUsageError(null);
    } else {
      setUsageError(apiErrorMessage(t, r.error));
    }
  }, [t]);

  useEffect(() => {
    if (account.signedIn) void loadUsage();
    else setUsage(null);
  }, [account.signedIn, loadUsage]);

  if (account.loading) return null;

  if (!account.signedIn) {
    return (
      <PfPage
        title={t("account.title")}
        subtitle={t("account.signedOutSubtitle")}
      >
        <div className="pf-card p-6 flex flex-col gap-5">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-[image:var(--pf-gradient)] flex items-center justify-center text-white">
              <UserRound size={20} />
            </div>
            <div>
              <div className="text-[15px] font-semibold text-pf-text">
                {t("account.signInTitle")}
              </div>
              <div className="text-[13px] text-pf-muted">
                {t("account.signInWhy")}
              </div>
            </div>
          </div>
          <SignIn linkError={account.linkError} />
        </div>
      </PfPage>
    );
  }

  const pct =
    usage && usage.daily_limit > 0
      ? Math.min(100, Math.round((usage.today / usage.daily_limit) * 100))
      : 0;

  const signOut = async () => {
    setSigningOut(true);
    await commands.authSignOut();
    setSigningOut(false);
  };

  const deleteAccount = async () => {
    setDeleting(true);
    setDeleteError(null);
    const r = await commands.accountDelete();
    setDeleting(false);
    if (r.status === "ok") setConfirmDelete(false);
    else setDeleteError(apiErrorMessage(t, r.error));
  };

  return (
    <PfPage title={t("account.title")} subtitle={t("account.subtitle")}>
      <div className="pf-card p-5 flex items-center gap-4">
        <div className="w-12 h-12 rounded-2xl bg-[image:var(--pf-gradient)] flex items-center justify-center text-white text-[18px] font-semibold uppercase">
          {(account.email ?? "?").slice(0, 1)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-semibold text-pf-text truncate">
            {account.email}
          </div>
          <div className="flex items-center gap-2 mt-1">
            <PfBadge tone="violet">
              {usage?.plan
                ? t("account.plan", { plan: usage.plan })
                : t("account.planBeta")}
            </PfBadge>
            {privateMode ? (
              <PfBadge tone="amber">{t("account.privateOn")}</PfBadge>
            ) : (
              <PfBadge tone="mint">{t("account.cloudOn")}</PfBadge>
            )}
          </div>
        </div>
        <button
          className="pf-button-secondary"
          onClick={() => void signOut()}
          disabled={signingOut}
        >
          <LogOut size={14} />
          {t("account.signOut")}
        </button>
      </div>

      <PfCard title={t("account.usage.title")}>
        <div className="px-4 py-4 flex flex-col gap-3">
          <div className="flex items-baseline gap-2">
            <span className="text-[28px] font-semibold text-pf-text tabular-nums">
              {usage ? usage.today : "–"}
            </span>
            <span className="text-[13px] text-pf-muted">
              {usage
                ? t("account.usage.ofLimit", { limit: usage.daily_limit })
                : t("account.usage.loading")}
            </span>
            <span className="flex-1" />
            <button
              className="text-pf-muted hover:text-pf-text transition-colors cursor-pointer"
              aria-label={t("account.usage.refresh")}
              onClick={() => void loadUsage()}
            >
              <RefreshCw
                size={14}
                className={loadingUsage ? "animate-spin" : ""}
              />
            </button>
          </div>
          <div className="h-2 rounded-full bg-pf-surface-2 overflow-hidden">
            <div
              className="h-full rounded-full bg-[image:var(--pf-gradient)] transition-[width] duration-700"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-[12.5px] text-pf-muted">
            {usageError ?? t("account.usage.resets")}
          </p>
        </div>
      </PfCard>

      <PfCard title={t("account.danger.title")}>
        <PfRow
          title={t("account.danger.delete")}
          description={t("account.danger.deleteDescription")}
        >
          <button
            className="pf-button-danger"
            onClick={() => {
              setDeleteError(null);
              setConfirmDelete(true);
            }}
          >
            <Trash2 size={14} />
            {t("account.danger.deleteButton")}
          </button>
        </PfRow>
      </PfCard>

      <Dialog
        open={confirmDelete}
        onOpenChange={(open) => !deleting && setConfirmDelete(open)}
        title={t("account.danger.confirmTitle")}
        description={t("account.danger.confirmBody", {
          email: account.email ?? "",
        })}
        closeLabel={t("common.close")}
        footer={
          <div className="flex justify-end gap-2">
            <button
              className="pf-button-secondary"
              disabled={deleting}
              onClick={() => setConfirmDelete(false)}
            >
              {t("common.cancel")}
            </button>
            <button
              className="pf-button-danger"
              disabled={deleting}
              onClick={() => void deleteAccount()}
            >
              {deleting
                ? t("account.danger.deleting")
                : t("account.danger.confirmButton")}
            </button>
          </div>
        }
      >
        {deleteError && (
          <p role="alert" className="text-[13px] text-pf-red">
            {deleteError}
          </p>
        )}
      </Dialog>
    </PfPage>
  );
};
