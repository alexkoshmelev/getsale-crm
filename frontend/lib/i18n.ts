import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import en from '@/locales/en.json';
import ru from '@/locales/ru.json';

export const defaultNS = 'translation';
export const supportedLngs = ['en', 'ru'] as const;
export type Locale = (typeof supportedLngs)[number];

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      ru: { translation: ru },
    },
    defaultNS: 'translation',
    fallbackLng: 'ru',
    supportedLngs: [...supportedLngs],
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: [],
      caches: [],
    },
  });

export default i18n;
