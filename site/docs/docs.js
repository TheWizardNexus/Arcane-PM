(function initializeDocumentation() {
    const menu = document.querySelector('.docs-menu');
    const overviewDetails = document.querySelector('.overview-details');
    const narrowScreen = window.matchMedia('(max-width: 980px)');
    function updateDocsMenu() {
        if (menu) menu.open = !narrowScreen.matches;
        if (overviewDetails) overviewDetails.open = !narrowScreen.matches;
    }
    updateDocsMenu();
    narrowScreen.addEventListener('change', updateDocsMenu);

    const main = document.querySelector('main');
    const contents = Array.from(document.querySelectorAll('.page-contents a')).map(function readContentsLink(link) {
        return { link, section: document.getElementById(link.hash.replace(/^#/, '')) };
    });
    let currentSection;
    function updateCurrentSection() {
        const readingPosition = main.getBoundingClientRect().top + main.clientHeight * .25;
        let current = contents[0];
        contents.forEach(function findReadingSection(item) {
            if (item.section && item.section.getBoundingClientRect().top <= readingPosition) current = item;
        });
        if (current === currentSection) return;
        if (currentSection) currentSection.link.removeAttribute('aria-current');
        if (current) current.link.setAttribute('aria-current', 'location');
        currentSection = current;
    }
    updateCurrentSection();
    main.addEventListener('scroll', updateCurrentSection, { passive: true });
    window.addEventListener('resize', updateCurrentSection);

    const searchForm = document.querySelector('[data-doc-search]');
    if (!searchForm) return;
    const queryInput = searchForm.querySelector('input');
    const status = document.querySelector('[data-search-status]');
    const results = document.querySelector('[data-search-results]');
    const pageNames = ['index', 'concepts', 'project-bridge', 'tasks', 'handoffs', 'handoff-example', 'local-ai', 'ui-components', 'storage'];
    let controller = new AbortController();
    let documentsPromise;
    let loadedDocuments;
    const failedPages = [];

    window.addEventListener('pagehide', function cancelDocumentationSearch() {
        controller.abort();
    });
    window.addEventListener('pageshow', function restoreDocumentationSearch(event) {
        if (!event.persisted) return;
        controller = new AbortController();
        documentsPromise = undefined;
        loadedDocuments = undefined;
        failedPages.length = 0;
        if (queryInput.value.trim()) searchDocumentation();
    });

    async function readPublicArticle(pageName, signal) {
        const response = await fetch(`${pageName}.html`, { signal });
        if (!response.ok) throw new Error(`Documentation page unavailable: ${pageName}`);
        const source = await response.text();
        const documentPage = new DOMParser().parseFromString(source, 'text/html');
        const article = documentPage.querySelector('[data-doc-article]');
        if (!article) throw new Error(`Documentation article unavailable: ${pageName}`);
        return {
            href: `${pageName}.html`,
            title: article.querySelector('h1').textContent,
            description: article.querySelector('.lede').textContent,
            content: article.textContent
        };
    }

    async function readDocumentation(signal) {
        const outcomes = await Promise.allSettled(pageNames.map(function readArticle(pageName) {
            return readPublicArticle(pageName, signal);
        }));
        if (signal.aborted) return [];
        const documents = [];
        outcomes.forEach(function keepCompleteArticle(outcome, index) {
            if (outcome.status === 'fulfilled') documents.push(outcome.value);
            else {
                failedPages.push(`${pageNames[index]}.html`);
                console.error('Could not read a public documentation article.', outcome.reason);
            }
        });
        return documents;
    }

    function renderSearch() {
        if (!loadedDocuments || controller.signal.aborted) return;
        const query = queryInput.value.trim().toLocaleLowerCase();
        const terms = query.split(/\s+/u).filter(Boolean);
        results.replaceChildren();
        if (!terms.length) {
            status.textContent = 'Enter a word or phrase to search the complete public articles.';
            return;
        }
        const matches = loadedDocuments.filter(function articleMatches(documentPage) {
            const searchableContent = documentPage.content.toLocaleLowerCase();
            return terms.every(function termMatches(term) { return searchableContent.includes(term); });
        });
        matches.forEach(function showArticle(documentPage) {
            const item = document.createElement('li');
            const heading = document.createElement('h2');
            const link = document.createElement('a');
            const description = document.createElement('p');
            link.href = documentPage.href;
            link.textContent = documentPage.title;
            description.textContent = documentPage.description;
            heading.append(link);
            item.append(heading, description);
            results.append(item);
        });
        const coverage = failedPages.length
            ? ` Searched ${loadedDocuments.length} of ${pageNames.length} articles. Unavailable pages: ${failedPages.join(', ')}. Reload this page to try again.`
            : ` Searched all ${pageNames.length} public articles.`;
        status.textContent = `${matches.length} ${matches.length === 1 ? 'article matches' : 'articles match'}.${coverage}`;
    }

    async function searchDocumentation(event) {
        if (event) {
            event.preventDefault();
            const searchURL = new URL(window.location.href);
            searchURL.searchParams.set('q', queryInput.value);
            history.replaceState(null, '', searchURL);
        }
        if (!queryInput.value.trim()) {
            status.textContent = 'Enter a word or phrase to search the complete public articles.';
            results.replaceChildren();
            return;
        }
        status.textContent = 'Searching the public documentation…';
        const signal = controller.signal;
        if (!documentsPromise) documentsPromise = readDocumentation(signal);
        const documents = await documentsPromise;
        if (signal.aborted) return;
        loadedDocuments = documents;
        renderSearch();
    }

    searchForm.addEventListener('submit', searchDocumentation);
    queryInput.addEventListener('input', renderSearch);
    const initialQuery = new URLSearchParams(window.location.search).get('q');
    if (initialQuery) {
        queryInput.value = initialQuery;
        searchDocumentation();
    }
}());
