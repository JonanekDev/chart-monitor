import { ref } from 'vue';

type Theme = 'dark' | 'light';

const STORAGE_KEY = 'theme';
const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
const theme = ref<Theme>(stored ?? 'dark');

function apply(value: Theme) {
  document.documentElement.setAttribute('data-theme', value);
}
apply(theme.value);

export function useTheme() {
  function toggle() {
    theme.value = theme.value === 'dark' ? 'light' : 'dark';
    localStorage.setItem(STORAGE_KEY, theme.value);
    apply(theme.value);
  }

  return { theme, toggle };
}
