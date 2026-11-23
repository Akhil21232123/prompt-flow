import React from "react";
import { HistorySettings } from "../history/HistorySettings";
import { CloudHistory } from "./CloudHistory";
import { useFlow } from "./useFlow";

/** Private mode keeps history on this Mac; the cloud keeps it in the account. */
export const HistoryPage: React.FC = () =>
  useFlow().privateMode ? <HistorySettings /> : <CloudHistory />;
