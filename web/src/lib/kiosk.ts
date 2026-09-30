import { createContext, useContext } from 'react';

/** Whether the app is running as a kiosk screen, and whether a grown-up has unlocked it with the PIN. */
export const KioskContext = createContext<{ active: boolean; unlocked: boolean }>({ active: false, unlocked: false });
export const useKiosk = () => useContext(KioskContext);
