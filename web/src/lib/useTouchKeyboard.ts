import { useEffect, useState } from 'react';
import { KeyboardMode, getKeyboardMode, installTouchKeyboard, keyboardWanted, setKeyboardMode } from './touchKeyboard';

/** This device's on-screen keyboard setting (auto / on / off), shared by every component that shows it. */
export function useKeyboardMode(): [KeyboardMode, (m: KeyboardMode) => void] {
  const [mode, setMode] = useState(getKeyboardMode);
  useEffect(() => {
    const update = () => setMode(getKeyboardMode());
    window.addEventListener('fh-osk-mode', update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener('fh-osk-mode', update);
      window.removeEventListener('storage', update);
    };
  }, []);
  return [mode, setKeyboardMode];
}

/** Shows the on-screen keyboard whenever a text box is tapped, when this device should have one. */
export function useTouchKeyboard(kiosk: boolean) {
  const [mode] = useKeyboardMode();
  const on = keyboardWanted(mode, kiosk);
  useEffect(() => {
    if (!on) return;
    const kb = installTouchKeyboard();
    return () => kb.destroy();
  }, [on]);
  return on;
}
