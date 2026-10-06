(function renderSiteShell() {
    const siteRoot = document.body.dataset.siteRoot || './';
    const section = document.body.dataset.section;
    const header = document.querySelector('[data-site-header]');
    const footer = document.querySelector('[data-site-footer]');
    const isDocs = section === 'docs';
    const navigation = isDocs ? [
        {label: 'Guides', path: 'docs/concepts.html'},
        {label: 'Reference', path: 'docs/storage.html'},
        {label: 'Examples', path: 'docs/handoff-example.html'}
    ] : [
        {label: 'How it works', path: 'how-it-works/index.html', section: 'how-it-works'},
        {label: 'Work locally', path: 'work-locally/index.html', section: 'work-locally'},
        {label: 'Developers', path: 'developers/index.html', section: 'developers'},
        {label: 'Docs', path: 'docs/index.html', section: 'docs'}
    ];
    const navLinks = navigation.map(function renderNavigation(item) {
        const current = item.section === section ? ' aria-current="location"' : '';
        return `<a href="${siteRoot}${item.path}"${current}>${item.label}</a>`;
    }).join('');
    const brand = `<span class="brand-mark" aria-hidden="true"></span><span class="brand-words">Arcane PM<small>by TWiN</small></span>`;
    const appearance = `<div class="theme-choices" role="group" aria-label="Color theme"><button type="button" data-theme-choice="light" aria-pressed="false">Light</button><button type="button" data-theme-choice="dark" aria-pressed="false">Dark</button><button type="button" data-theme-choice="system" aria-pressed="false">System</button></div>`;
    const sun = `<svg class="shell-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></svg>`;
    const searchIcon = `<svg class="shell-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>`;
    const github = `<a class="github-link" href="https://github.com/TheWizardNexus/Arcane-PM" aria-label="GitHub repository"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.86c-2.78.6-3.37-1.18-3.37-1.18-.45-1.15-1.11-1.46-1.11-1.46-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.64-1.33-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.6 9.6 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"/></svg></a>`;
    const compactAppearance = `<details class="compact-appearance"><summary aria-label="Appearance"><span class="theme-light-image">${sun}</span><svg class="shell-icon theme-dark-image" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15.2A8.5 8.5 0 0 1 8.8 4a8.5 8.5 0 1 0 11.2 11.2Z"/></svg></summary><div class="appearance-panel"><span class="menu-label">Appearance</span>${appearance}</div></details>`;

    if (header) {
        header.classList.add('site-header');
        header.innerHTML = `<a class="skip-link" href="#main-content">Skip to content</a>
            <div class="header-inner">
                <div class="header-brand"><a class="brand" href="${siteRoot}index.html" aria-label="Arcane PM home">${brand}</a>${isDocs ? `<a class="docs-label" href="${siteRoot}docs/index.html">Docs</a>` : ''}</div>
                <nav class="desktop-nav" aria-label="Main navigation">${navLinks}${isDocs ? '' : github}</nav>
                ${isDocs ? `<form class="header-search" action="${siteRoot}docs/search.html" method="get" role="search">${searchIcon}<input name="q" type="search" aria-label="Search the docs" placeholder="Search the docs"><kbd>Ctrl K</kbd></form><a class="search-link" href="${siteRoot}docs/search.html">${searchIcon}<span>Search</span></a>${github}` : ''}
                <div class="desktop-appearance"><span class="appearance-cue">${sun}</span>${appearance}</div>
                ${compactAppearance}
                ${isDocs ? '' : `<details class="mobile-menu">
                    <summary><span aria-hidden="true">☰</span> Menu</summary>
                    <div class="mobile-menu-panel">
                        <nav aria-label="Mobile navigation">${navLinks}<a href="${siteRoot}docs/search.html">Search documentation</a><a href="https://github.com/TheWizardNexus/Arcane-PM">GitHub ↗</a></nav>
                    </div>
                </details>`}
            </div>`;
    }
    if (footer) {
        footer.classList.add('site-footer');
        footer.innerHTML = isDocs ? `<p>Application under development</p>` : `<a class="brand" href="${siteRoot}index.html" aria-label="Arcane PM home">${brand}</a><p><a href="${siteRoot}docs/search.html">Search docs</a><span aria-hidden="true"> · </span>Design previews use sample content</p>`;
    }
    const topicNav = document.querySelector('[data-topic-nav]');
    if (topicNav) {
        const topics = [
            {label: 'Overview', path: 'how-it-works/index.html', key: 'overview'},
            {label: 'Your team', path: 'team/index.html', key: 'team'},
            {label: 'Original sources', path: 'how-it-works/sources/index.html', key: 'sources'},
            {label: 'Handoffs', path: 'handoffs/index.html', key: 'handoffs'},
            {label: 'Work locally', path: 'work-locally/index.html', key: 'local'},
            {label: 'Tidy up', path: 'tidy-up/index.html', key: 'tidy'},
            {label: 'Developers', path: 'developers/index.html', key: 'developers'}
        ];
        topicNav.innerHTML = topics.map(function renderTopic(item) {
            const current = item.key === document.body.dataset.topic ? ' aria-current="page"' : '';
            return `<a href="${siteRoot}${item.path}"${current}>${item.label}</a>`;
        }).join('');
    }
    document.addEventListener('keydown', function handleShellKeys(event) {
        if (event.key === 'Escape') {
            const focusedDisclosure = event.target.closest?.('details[open]');
            const disclosure = header?.contains(focusedDisclosure) ? focusedDisclosure : header?.querySelector('details[open]');
            if (disclosure) {
                disclosure.open = false;
                disclosure.querySelector('summary').focus();
            }
        }
        if (isDocs && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
            event.preventDefault();
            const search = header.querySelector('.header-search input');
            if (search.getClientRects().length) {
                search.focus();
            } else {
                header.querySelector('.search-link').click();
            }
        }
    });
    document.dispatchEvent(new Event('arcane-pm-shell-ready'));
}());
