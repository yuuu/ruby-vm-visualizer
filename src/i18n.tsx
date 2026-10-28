// Display language (Japanese / English). Callers write each text as a Japanese/English pair.
import { createContext, ReactNode, useContext } from "react";

export type Lang = "ja" | "en";

export const LangContext = createContext<Lang>("ja");

export function useLang(): Lang {
  return useContext(LangContext);
}

/** Returns a function that picks the text for the current language, as t(japanese, english) */
export function useT() {
  const lang = useLang();
  return (ja: string, en: string) => (lang === "en" ? en : ja);
}

/** Switches whole JSX fragments by language */
export function T({ ja, en }: { ja: ReactNode; en: ReactNode }) {
  return <>{useLang() === "en" ? en : ja}</>;
}

export function pick<V>(lang: Lang, ja: V, en: V): V {
  return lang === "en" ? en : ja;
}

/** Uses the saved setting, or English if there is none */
export function initialLang(): Lang {
  try {
    const saved = localStorage.getItem("lang");
    if (saved === "ja" || saved === "en") return saved;
  } catch {
    /* fall back to the default if it cannot be read */
  }
  return "en";
}
