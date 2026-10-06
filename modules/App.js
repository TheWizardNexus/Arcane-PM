import 'arcane-os/modules/HTMLImport.js';
import {pmData, getStorage} from './data/index.js';
import {mountTeamView, mountTaskView} from './ui/index.js';
import {createTaskActivity} from './task-activity.js';

const content = document.querySelector('#pm-content');
const menu = document.querySelector('.pm-mobile-menu');
const search = document.querySelector('.pm-search-button');
const projectPicker = document.querySelector('#pm-project');
const statusLine = document.querySelector('.pm-status');
const connectionStatus = document.querySelector('.pm-connection-status');
const lifetime = new AbortController();
const titles = {
    team: 'Your team', task: 'Task', sources: 'Find anything', handoffs: 'Handoffs',
    cleanup: 'Tidy up', 'local-ai': 'Local preparation', connections: 'Connections'
};
let selectedProject = null;
let currentView;
let routeLifetime;
let projectRevision = 0;
let bridgeReady;
let modelsReady;
let workflowsReady;
let sourcesReady;
let handoffsReady;
let cleanupReady;

function onStatus(message) {
    statusLine.textContent = message;
    statusLine.hidden = !message;
}

function getBridge() {
    if (!bridgeReady) bridgeReady = openBridge().catch(bridgeFailed);
    return bridgeReady;
}

async function openBridge() {
    const module = await import('./bridge/index.js');
    const bridge = module.createCodexBridge();
    bridge.subscribe(updateConnection, {signal: lifetime.signal, emitCurrent: true});
    const taskActivity = createTaskActivity({pmData, bridge, signal: lifetime.signal, onError: onStatus});
    return {bridge, taskActivity, mountConnectionsView: module.mountConnectionsView};
}

function getTaskActivity() {
    return getBridge().then(function readTaskActivity(connection) { return connection.taskActivity; });
}

function bridgeFailed(error) {
    bridgeReady = null;
    throw error;
}

function reportBridgeFailure(error) {
    if (!lifetime.signal.aborted) {
        console.error('Arcane PM connection services could not open.', error);
        connectionStatus.textContent = 'Codex connection unavailable';
    }
}

function updateConnection(state) {
    if (state.pendingRequests?.length) {
        connectionStatus.textContent = 'Codex needs your input';
    } else {
        connectionStatus.textContent = state.connected ? 'Codex connected' : state.state === 'connecting' ? 'Connecting to Codex…' : 'Connect to Codex';
    }
}

function getModels() {
    if (!modelsReady) {
        modelsReady = openModels().catch(modelsFailed);
        modelsReady.catch(reportModelFailure);
    }
    return modelsReady;
}

async function openModels() {
    const module = await import('./local-ai/index.js');
    const services = module.createPMPreparationServices(
        {getStorage, pmData, signal: lifetime.signal}
    );
    return {...services, mountLocalAIView: module.mountLocalAIView};
}

function modelsFailed(error) {
    modelsReady = null;
    throw error;
}

function reportModelFailure(error) {
    if (!lifetime.signal.aborted) console.error('Arcane PM preparation services could not open.', error);
}

function getWorkflows() {
    if (!workflowsReady) workflowsReady = openWorkflows().catch(workflowsFailed);
    return workflowsReady;
}

async function openWorkflows() {
    const module = await import('./workflows/index.js');
    return {workflows: module.createWorkflowService({pmData, getStorage}), mountGuideView: module.mountGuideView};
}

function workflowsFailed(error) {
    workflowsReady = null;
    throw error;
}

function getSources() {
    if (!sourcesReady) sourcesReady = openSources().catch(sourcesFailed);
    return sourcesReady;
}

async function openSources() {
    const [module, connection] = await Promise.all(
        [import('./sources/index.js'), getBridge()]
    );
    const sources = module.createSourceLibrary(
        {getStorage, pmData, bridge: connection.bridge}
    );
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = './modules/sources/sources.css';
    document.head.append(stylesheet);
    return {sources, mountSourcesView: module.mountSourcesView};
}

function sourcesFailed(error) {
    sourcesReady = null;
    throw error;
}

function getHandoffs() {
    if (!handoffsReady) handoffsReady = openHandoffs().catch(handoffsFailed);
    return handoffsReady;
}

async function openHandoffs() {
    const [module, library, connection, preparation] = await Promise.all(
        [import('./handoffs/index.js'), getSources(), getBridge(), getModels()]
    );
    const handoffs = module.createHandoffService(
        {pmData, getStorage, sourceLibrary: library.sources, bridge: connection.bridge, localAI: preparation.localAI}
    );
    return {handoffs, sourceLibrary: library.sources, mountHandoffsView: module.mountHandoffsView};
}

function handoffsFailed(error) {
    handoffsReady = null;
    throw error;
}

function getCleanup() {
    if (!cleanupReady) cleanupReady = openCleanup().catch(cleanupFailed);
    return cleanupReady;
}

async function openCleanup() {
    const [module, connection, transfers] = await Promise.all(
        [import('./cleanup/index.js'), getBridge(), getHandoffs()]
    );
    const cleanup = module.createCleanupService(
        {pmData, bridge: connection.bridge, disposableResources: transfers.handoffs.disposableResources}
    );
    return {cleanup, mountCleanupView: module.mountCleanupView};
}

function cleanupFailed(error) {
    cleanupReady = null;
    throw error;
}

function onNavigate(route, parameters = {}) {
    const query = new URLSearchParams();
    const projectId = Object.hasOwn(parameters, 'projectId') ? parameters.projectId : selectedProject;
    if (projectId) query.set('projectId', projectId);
    for (const key of ['taskId', 'sourceId', 'handoffId']) {
        if (parameters[key]) query.set(key, parameters[key]);
    }
    const next = `#${route}${query.toString() ? `?${query}` : ''}`;
    if (location.hash === next) renderRoute();
    else location.hash = next;
}

function navigateToSources() {
    onNavigate('sources');
}

function toggleNavigation() {
    const open = menu.getAttribute('aria-expanded') !== 'true';
    menu.setAttribute('aria-expanded', String(open));
    document.body.dataset.navigation = open ? 'open' : 'closed';
}

function handleShortcut(event) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        navigateToSources();
    }
    if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') {
        toggleNavigation();
        menu.focus();
    }
}

function selectProject() {
    const route = location.hash.substring(1).split('?')[0];
    onNavigate(route === 'task' ? 'team' : Object.hasOwn(titles, route) ? route : 'team', {projectId: projectPicker.value || null});
}

async function refreshProjects() {
    const revision = ++projectRevision;
    try {
        const projects = await pmData.listProjects({archived: false, signal: lifetime.signal});
        if (lifetime.signal.aborted || revision !== projectRevision) return;
        const all = document.createElement('option');
        all.value = '';
        all.textContent = 'All projects';
        projectPicker.replaceChildren(all);
        for (const project of projects) {
            const option = document.createElement('option');
            option.value = project.id;
            option.textContent = project.name;
            projectPicker.append(option);
        }
        if (selectedProject && !projects.some(isSelectedProject)) {
            const missing = document.createElement('option');
            missing.value = selectedProject;
            missing.textContent = 'Selected project unavailable';
            projectPicker.append(missing);
        }
        projectPicker.value = selectedProject || '';
    } catch (error) {
        if (lifetime.signal.aborted) return;
        console.error('Arcane PM project list could not be opened.', error);
        onStatus('Local projects could not be opened. Reopen the page to retry.');
    }
}

function isSelectedProject(project) {
    return project.id === selectedProject;
}

function projectRecordChanged(change) {
    if (change.recordType === 'project') refreshProjects();
}

function disposeView() {
    routeLifetime?.abort();
    if (typeof currentView === 'function') currentView();
    else currentView?.dispose?.();
    currentView = null;
}

function renderRoute() {
    disposeView();
    routeLifetime = new AbortController();
    const [requestedRoute, query = ''] = location.hash.substring(1).split('?');
    const route = Object.hasOwn(titles, requestedRoute) ? requestedRoute : 'team';
    const parameters = new URLSearchParams(query);
    selectedProject = parameters.get('projectId') || null;
    projectPicker.value = selectedProject || '';
    const options = {
        pmData,
        projectId: selectedProject,
        taskId: parameters.get('taskId'),
        sourceId: parameters.get('sourceId'),
        handoffId: parameters.get('handoffId'),
        onNavigate,
        onStatus,
        signal: routeLifetime.signal
    };
    for (const link of document.querySelectorAll('[data-route]')) {
        const selected = link.dataset.route === (route === 'task' ? 'team' : route);
        if (selected) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
        link.href = `${location.pathname}${location.search}#${link.dataset.route}${selectedProject ? `?projectId=${encodeURIComponent(selectedProject)}` : ''}`;
    }
    connectionStatus.href = `${location.pathname}${location.search}#connections${selectedProject ? `?projectId=${encodeURIComponent(selectedProject)}` : ''}`;
    document.querySelector('.pm-brand').href = `${location.pathname}${location.search}#team${selectedProject ? `?projectId=${encodeURIComponent(selectedProject)}` : ''}`;
    document.title = `${titles[route]} · Arcane PM`;
    menu.setAttribute('aria-expanded', 'false');
    document.body.dataset.navigation = 'closed';
    content.scrollTop = 0;
    onStatus('');
    if (route === 'team') {
        currentView = mountTeamView(
            content,
            {...options, modelsReady: getModels(), workflowsReady: getWorkflows(), taskActivityReady: getTaskActivity()}
        );
        return;
    }
    if (route === 'task') {
        currentView = mountTaskView(content, {...options, modelsReady: getModels(), taskActivityReady: getTaskActivity()});
        return;
    }
    const heading = document.createElement('h1');
    heading.textContent = titles[route];
    const opening = document.createElement('p');
    opening.textContent = 'Opening…';
    content.replaceChildren(heading, opening);
    mountFeature(route, options).catch(featureFailed);

    function featureFailed(error) {
        if (options.signal.aborted) return;
        console.error(`Arcane PM ${route} could not open.`, error);
        const message = document.createElement('p');
        message.className = 'pm-notice';
        message.textContent = 'This part of your workspace could not open. Your saved work is retained.';
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'arcane-button';
        retry.textContent = 'Try again';
        retry.addEventListener('click', renderRoute);
        content.replaceChildren(heading, message, retry);
    }
}

async function mountFeature(route, options) {
    let services;
    let mount;
    if (route === 'sources') {
        services = await getSources();
        mount = services.mountSourcesView;
    } else if (route === 'handoffs') {
        services = await getHandoffs();
        mount = services.mountHandoffsView;
    } else if (route === 'cleanup') {
        services = await getCleanup();
        mount = services.mountCleanupView;
    } else if (route === 'local-ai') {
        services = await getModels();
        mount = services.mountLocalAIView;
    } else {
        services = await getBridge();
        mount = services.mountConnectionsView;
    }
    if (options.signal.aborted) return;
    content.replaceChildren();
    currentView = mount(content, {...services, ...options});
}

function skipToWorkspace(event) {
    event.preventDefault();
    content.focus();
}

function closeApplication(event) {
    if (event.persisted) return;
    lifetime.abort();
    disposeView();
    Promise.allSettled(
        [bridgeReady, modelsReady, workflowsReady, sourcesReady, handoffsReady, cleanupReady]
    ).then(releaseServices);
}

async function releaseServices(results) {
    const closing = [];
    for (const result of results) {
        if (result.status !== 'fulfilled' || !result.value) continue;
        const service = result.value;
        if (service.dispose) closing.push(service.dispose());
        else {
            service.taskActivity?.dispose?.();
            service.bridge?.dispose?.();
            service.workflows?.dispose?.();
            service.sources?.dispose?.();
            service.handoffs?.dispose?.();
            service.cleanup?.dispose?.();
        }
    }
    await Promise.allSettled(closing);
}

menu.addEventListener('click', toggleNavigation);
search.addEventListener('click', navigateToSources);
projectPicker.addEventListener('change', selectProject);
document.querySelector('.pm-skip-link').addEventListener('click', skipToWorkspace);
document.addEventListener('keydown', handleShortcut);
globalThis.addEventListener('hashchange', renderRoute);
globalThis.addEventListener('pagehide', closeApplication);
pmData.subscribe(projectRecordChanged, {signal: lifetime.signal});
renderRoute();
refreshProjects();
getBridge().catch(reportBridgeFailure);
