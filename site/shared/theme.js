(function initializeSiteTheme() {
    const root = document.documentElement;
    const system = window.matchMedia('(prefers-color-scheme: dark)');
    const storageKey = 'arcane-pm-site-theme';
    let preference = 'system';

    try {
        preference = localStorage.getItem(storageKey) || 'system';
    } catch (error) {
        console.warn('The site appearance preference could not be read.', error);
    }

    function applyAppearance() {
        root.dataset.themePreference = preference;
        root.dataset.theme = preference === 'system'
            ? (system.matches ? 'dark' : 'light')
            : preference;
        document.querySelectorAll('[data-theme-choice]').forEach(function updateChoice(button) {
            button.setAttribute('aria-pressed', String(button.dataset.themeChoice === preference));
        });
    }

    applyAppearance();
    system.addEventListener('change', applyAppearance);
    document.addEventListener('click', function selectAppearance(event) {
        const button = event.target.closest('[data-theme-choice]');
        if (!button) return;
        preference = button.dataset.themeChoice;
        applyAppearance();
        try {
            localStorage.setItem(storageKey, preference);
        } catch (error) {
            console.warn('The site appearance preference could not be saved.', error);
        }
    });
    document.addEventListener('arcane-pm-shell-ready', applyAppearance, {once: true});
    window.addEventListener('storage', function syncAppearance(event) {
        if (event.key !== storageKey) return;
        preference = event.newValue || 'system';
        applyAppearance();
    });
}());
