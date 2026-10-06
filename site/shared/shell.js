(function renderSiteShell() {
    const siteRoot = document.body.dataset.siteRoot || './';
    const section = document.body.dataset.section;
    const header = document.querySelector('[data-site-header]');
    const footer = document.querySelector('[data-site-footer]');
    const navigation = [
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

    if (header) {
        header.classList.add('site-header');
        header.innerHTML = `<a class="skip-link" href="#main-content">Skip to content</a>
            <div class="header-inner">
                <a class="brand" href="${siteRoot}index.html" aria-label="Arcane PM home">${brand}</a>
                <nav class="desktop-nav" aria-label="Main navigation">${navLinks}<a href="https://github.com/TheWizardNexus/Arcane-PM">GitHub <span aria-hidden="true">↗</span></a></nav>
                <a class="search-link" href="${siteRoot}docs/search.html" aria-label="Search documentation"><span aria-hidden="true">⌕</span><span>Search</span></a>
                <div class="desktop-appearance">${appearance}</div>
                <details class="mobile-menu">
                    <summary><span aria-hidden="true">☰</span> Menu</summary>
                    <div class="mobile-menu-panel">
                        <nav aria-label="Mobile navigation">${navLinks}<a href="https://github.com/TheWizardNexus/Arcane-PM">GitHub ↗</a></nav>
                        <span class="menu-label">Appearance</span>${appearance}
                    </div>
                </details>
            </div>`;
    }
    if (footer) {
        footer.classList.add('site-footer');
        footer.innerHTML = `<a class="brand" href="${siteRoot}index.html" aria-label="Arcane PM home">${brand}</a><p>In development <span aria-hidden="true">·</span> Design previews use sample content</p>`;
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
    document.addEventListener('keydown', function closeMobileMenu(event) {
        const menu = document.querySelector('.mobile-menu[open]');
        if (event.key === 'Escape' && menu) {
            menu.open = false;
            menu.querySelector('summary').focus();
        }
    });
    document.dispatchEvent(new Event('arcane-pm-shell-ready'));
}());
