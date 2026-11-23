import { useEffect, useState } from "react";
import type { TFunction } from "i18next";
import { commands, events } from "@/bindings";
import type { AccountStatus, ApiError, UpdateInfo } from "@/bindings";

/** Plain-language text for a failed cloud call. */
export const apiErrorMessage = (t: TFunction, e: unknown): string => {
  const err = e as Partial<ApiError> | undefined;
  switch (err?.code) {
    case "network":
      return t("cloud.errors.network");
    case "timeout":
      return t("cloud.errors.timeout");
    case "rate_limited":
      return err.retry_after_sec
        ? t("cloud.errors.rateLimitedFor", { seconds: err.retry_after_sec })
        : t("cloud.errors.rateLimited");
    case "quota":
      return t("cloud.errors.quota");
    case "auth":
      return t("cloud.errors.auth");
    default:
      return err?.message?.trim() || t("cloud.errors.generic");
  }
};

/** The signed-in account, kept current by `account-changed`. */
export const useAccount = () => {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    commands.authStatus().then((s) => !disposed && setStatus(s));
    const unlisten = events.accountChanged.listen((e) => {
      setStatus(e.payload.status);
      setLinkError(e.payload.link_error);
    });
    return () => {
      disposed = true;
      unlisten.then((u) => u());
    };
  }, []);
  return {
    status,
    loading: status === null,
    signedIn: status?.signed_in ?? false,
    email: status?.email ?? null,
    linkError,
    clearLinkError: () => setLinkError(null),
  };
};

const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;

/** "Update available": checks the mac-latest release now and every 6 hours. */
export const useMacUpdate = () => {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  useEffect(() => {
    let disposed = false;
    const check = () =>
      commands.checkMacUpdate().then((r) => {
        if (!disposed && r.status === "ok") setInfo(r.data);
      });
    check();
    const timer = setInterval(check, UPDATE_EVERY_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);
  return info;
};

/** Spoken languages the cloud understands, in the picker's order. */
export const SPOKEN_LANGUAGES = [
  "en",
  "hi",
  "te",
  "ta",
  "kn",
  "ml",
  "mr",
  "bn",
  "gu",
  "pa",
  "ur",
  "auto",
] as const;
export type SpokenLanguage = (typeof SPOKEN_LANGUAGES)[number];
