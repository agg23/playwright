/*
  Copyright (c) Microsoft Corporation.

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

import { SplitView } from '@web/components/splitView';
import * as React from 'react';
import { ActionList } from './actionList';
import { CallTab } from './callTab';
import { LogTab } from './logTab';
import { ErrorsTab, useErrorsTabModel } from './errorsTab';
import type { ConsoleEntry } from './consoleTab';
import { ConsoleTab, useConsoleTabModel } from './consoleTab';
import type * as modelUtil from './modelUtil';
import { NetworkTab, useNetworkTabModel } from './networkTab';
import { SnapshotTabsView } from './snapshotTab';
import { SourceTab } from './sourceTab';
import { TabbedPane } from '@web/components/tabbedPane';
import type { TabbedPaneTabModel } from '@web/components/tabbedPane';
import { Timeline } from './timeline';
import { MetadataView } from './metadataView';
import { AttachmentsTab } from './attachmentsTab';
import { AnnotationsTab } from './annotationsTab';
import type { Boundaries } from './geometry';
import { InspectorTab } from './inspectorTab';
import { ToolbarButton } from '@web/components/toolbarButton';
import { useSetting, msToString, clsx } from '@web/uiUtils';
import type { Entry } from '@trace/har';
import './workbench.css';
import { testStatusIcon, testStatusText } from './testUtils';
import type { UITestStatus } from './testUtils';
import type { AfterActionTraceEventAttachment } from '@trace/trace';
import type { HighlightedElement } from './snapshotTab';
import type { TestAnnotation } from '@playwright/test';
import { MetadataWithCommitInfo } from '@testIsomorphic/types';

export const Workbench: React.FunctionComponent<{
  model?: modelUtil.MultiTraceModel,
  showSourcesFirst?: boolean,
  rootDir?: string,
  fallbackLocation?: modelUtil.SourceLocation,
  isLive?: boolean,
  hideTimeline?: boolean,
  status?: UITestStatus,
  annotations?: TestAnnotation[];
  inert?: boolean,
  onOpenExternally?: (location: modelUtil.SourceLocation) => void,
  revealSource?: boolean,
  testRunMetadata?: MetadataWithCommitInfo,
}> = ({ model, showSourcesFirst, rootDir, fallbackLocation, isLive, hideTimeline, status, annotations, inert, onOpenExternally, revealSource, testRunMetadata }) => {
  const [selectedCallId, setSelectedCallId] = React.useState<string | undefined>(undefined);
  const [revealedError, setRevealedError] = React.useState<modelUtil.ErrorDescription | undefined>(undefined);
  const [revealedAttachment, setRevealedAttachment] = React.useState<[attachment: AfterActionTraceEventAttachment, renderCounter: number] | undefined>(undefined);
  const [highlightedCallId, setHighlightedCallId] = React.useState<string | undefined>();
  const [highlightedEntry, setHighlightedEntry] = React.useState<Entry | undefined>();
  const [highlightedConsoleMessage, setHighlightedConsoleMessage] = React.useState<ConsoleEntry | undefined>();
  const [selectedNavigatorTab, setSelectedNavigatorTab] = React.useState<string>('actions');
  const [selectedPropertiesTab, setSelectedPropertiesTab] = useSetting<string>('propertiesTab', showSourcesFirst ? 'source' : 'call');
  const [isInspecting, setIsInspectingState] = React.useState(false);
  const [highlightedElement, setHighlightedElement] = React.useState<HighlightedElement>({ lastEdited: 'none' });
  const [selectedTime, setSelectedTime] = React.useState<Boundaries | undefined>();
  const [sidebarLocation, setSidebarLocation] = useSetting<'bottom' | 'right'>('propertiesSidebarLocation', 'bottom');

  const setSelectedAction = React.useCallback((action: modelUtil.ActionTraceEventInContext | undefined) => {
    setSelectedCallId(action?.callId);
    setRevealedError(undefined);
  }, []);

  const highlightedAction = React.useMemo(() => {
    return model?.actions.find(a => a.callId === highlightedCallId);
  }, [model, highlightedCallId]);

  const setHighlightedAction = React.useCallback((highlightedAction: modelUtil.ActionTraceEventInContext | undefined) => {
    setHighlightedCallId(highlightedAction?.callId);
  }, []);

  const sources = React.useMemo(() => model?.sources || new Map<string, modelUtil.SourceModel>(), [model]);

  React.useEffect(() => {
    setSelectedTime(undefined);
    setRevealedError(undefined);
  }, [model]);

  const selectedAction = React.useMemo(() => {
    if (selectedCallId) {
      const action = model?.actions.find(a => a.callId === selectedCallId);
      if (action)
        return action;
    }

    const failedAction = model?.failedAction();
    if (failedAction)
      return failedAction;

    if (model?.actions.length) {
      // Select the last non-after hooks item.
      let index = model.actions.length - 1;
      for (let i = 0; i < model.actions.length; ++i) {
        if (model.actions[i].title === 'After Hooks' && i) {
          index = i - 1;
          break;
        }
      }
      return model.actions[index];
    }
  }, [model, selectedCallId]);

  const activeAction = React.useMemo(() => {
    return highlightedAction || selectedAction;
  }, [selectedAction, highlightedAction]);

  const revealedStack = React.useMemo(() => {
    if (revealedError)
      return revealedError.stack;
    return activeAction?.stack;
  }, [activeAction, revealedError]);

  const onActionSelected = React.useCallback((action: modelUtil.ActionTraceEventInContext) => {
    setSelectedAction(action);
    setHighlightedAction(undefined);
  }, [setSelectedAction, setHighlightedAction]);

  const selectPropertiesTab = React.useCallback((tab: string) => {
    setSelectedPropertiesTab(tab);
    if (tab !== 'inspector')
      setIsInspectingState(false);
  }, [setSelectedPropertiesTab]);

  const revealConsole = React.useCallback(() => selectPropertiesTab('console'), [selectPropertiesTab]);

  const setIsInspecting = React.useCallback((value: boolean) => {
    if (!isInspecting && value)
      selectPropertiesTab('inspector');
    setIsInspectingState(value);
  }, [setIsInspectingState, selectPropertiesTab, isInspecting]);

  const elementPicked = React.useCallback((element: HighlightedElement) => {
    setHighlightedElement(element);
    selectPropertiesTab('inspector');
  }, [selectPropertiesTab]);

  const revealAttachment = React.useCallback((attachment: AfterActionTraceEventAttachment) => {
    selectPropertiesTab('attachments');
    setRevealedAttachment(currentValue => {
      if (!currentValue)
        return [attachment, 0];
      const revealCounter = currentValue[1];
      return [attachment, revealCounter + 1];
    });
  }, [selectPropertiesTab]);

  React.useEffect(() => {
    if (revealSource)
      selectPropertiesTab('source');
  }, [revealSource, selectPropertiesTab]);

  const consoleModel = useConsoleTabModel(model, selectedTime);
  const networkModel = useNetworkTabModel(model, selectedTime);
  const errorsModel = useErrorsTabModel(model);

  const sdkLanguage = model?.sdkLanguage || 'javascript';

  const inspectorTab = React.useMemo<TabbedPaneTabModel>(() => ({
    id: 'inspector',
    title: 'Locator',
    component: <InspectorTab
      sdkLanguage={sdkLanguage}
      setIsInspecting={setIsInspecting}
      highlightedElement={highlightedElement}
      setHighlightedElement={setHighlightedElement} />,
  }), [sdkLanguage, setIsInspecting, highlightedElement, setHighlightedElement]);

  const callTab = React.useMemo<TabbedPaneTabModel>(() => ({
    id: 'call',
    title: 'Call',
    component: <CallTab action={activeAction} startTimeOffset={model?.startTime ?? 0} sdkLanguage={sdkLanguage} />
  }), [activeAction, model, sdkLanguage]);

  const logTab = React.useMemo<TabbedPaneTabModel>(() => ({
    id: 'log',
    title: 'Log',
    component: <LogTab action={activeAction} isLive={isLive} />
  }), [activeAction, isLive]);

  const revealInSource = React.useCallback((error: modelUtil.ErrorDescription) => {
    if (error.action)
      setSelectedAction(error.action);
    else
      setRevealedError(error);
    selectPropertiesTab('source');
  }, [selectPropertiesTab, setRevealedError, setSelectedAction]);

  const { boundaries } = React.useMemo(() => {
    const boundaries = { minimum: model?.startTime || 0, maximum: model?.endTime || 30000 };
    if (boundaries.minimum > boundaries.maximum) {
      boundaries.minimum = 0;
      boundaries.maximum = 30000;
    }
    // Leave some nice free space on the right hand side.
    boundaries.maximum += (boundaries.maximum - boundaries.minimum) / 20;
    return { boundaries };
  }, [model]);

  const errorsTab = React.useMemo<TabbedPaneTabModel>(() => ({
    id: 'errors',
    title: 'Errors',
    errorCount: errorsModel.errors.size,
    component: <ErrorsTab errorsModel={errorsModel} model={model} testRunMetadata={testRunMetadata} sdkLanguage={sdkLanguage} revealInSource={revealInSource} wallTime={model?.wallTime ?? 0} />
  }), [errorsModel, model, testRunMetadata, sdkLanguage, revealInSource]);

  // Fallback location w/o action stands for file / test.
  // Render error count on Source tab for that case.
  let fallbackSourceErrorCount: number | undefined = undefined;
  if (!selectedAction && fallbackLocation)
    fallbackSourceErrorCount = fallbackLocation.source?.errors.length;

  const sourceTab = React.useMemo<TabbedPaneTabModel>(() => ({
    id: 'source',
    title: 'Source',
    errorCount: fallbackSourceErrorCount,
    component: <SourceTab
      stack={revealedStack}
      sources={sources}
      rootDir={rootDir}
      stackFrameLocation={sidebarLocation === 'bottom' ? 'right' : 'bottom'}
      fallbackLocation={fallbackLocation}
      onOpenExternally={onOpenExternally}
    />
  }), [fallbackSourceErrorCount, revealedStack, sources, rootDir, sidebarLocation, fallbackLocation, onOpenExternally]);

  const onConsoleAccepted = React.useCallback((m: ConsoleEntry) => setSelectedTime({ minimum: m.timestamp, maximum: m.timestamp }), [setSelectedTime]);

  const consoleTab = React.useMemo<TabbedPaneTabModel>(() => ({
    id: 'console',
    title: 'Console',
    count: consoleModel.entries.length,
    component: <ConsoleTab
      consoleModel={consoleModel}
      boundaries={boundaries}
      selectedTime={selectedTime}
      onAccepted={onConsoleAccepted}
      onEntryHovered={setHighlightedConsoleMessage}
    />
  }), [consoleModel, boundaries, selectedTime, onConsoleAccepted, setHighlightedConsoleMessage]);

  const networkTab = React.useMemo<TabbedPaneTabModel>(() => ({
    id: 'network',
    title: 'Network',
    count: networkModel.resources.length,
    component: <NetworkTab boundaries={boundaries} networkModel={networkModel} onEntryHovered={setHighlightedEntry} sdkLanguage={model?.sdkLanguage ?? 'javascript'} />
  }), [boundaries, networkModel, setHighlightedEntry, model]);

  const attachmentsTab = React.useMemo<TabbedPaneTabModel>(() => ({
    id: 'attachments',
    title: 'Attachments',
    count: model?.visibleAttachments.length,
    component: <AttachmentsTab model={model} revealedAttachment={revealedAttachment} />
  }), [model, revealedAttachment]);

  const tabs: TabbedPaneTabModel[] = React.useMemo(() => {
    const tabs = [
      inspectorTab,
      callTab,
      logTab,
      errorsTab,
      consoleTab,
      networkTab,
      sourceTab,
      attachmentsTab,
    ];

    if (annotations !== undefined) {
      const annotationsTab = {
        id: 'annotations',
        title: 'Annotations',
        count: annotations.length,
        component: <AnnotationsTab annotations={annotations} />
      };
      tabs.push(annotationsTab);
    }

    if (showSourcesFirst) {
      const sourceTabIndex = tabs.indexOf(sourceTab);
      tabs.splice(sourceTabIndex, 1);
      tabs.splice(1, 0, sourceTab);
    }

    return tabs;
  }, [inspectorTab, callTab, logTab, errorsTab, consoleTab, networkTab, sourceTab, attachmentsTab, annotations, showSourcesFirst]);

  let time: number = 0;
  if (!isLive && model && model.endTime >= 0)
    time = model.endTime - model.startTime;
  else if (model && model.wallTime)
    time = Date.now() - model.wallTime;

  const actionsTab: TabbedPaneTabModel = {
    id: 'actions',
    title: 'Actions',
    component: <div className='vbox'>
      {status && <div className='workbench-run-status'>
        <span className={clsx('codicon', testStatusIcon(status))}></span>
        <div>{testStatusText(status)}</div>
        <div className='spacer'></div>
        <div className='workbench-run-duration'>{time ? msToString(time) : ''}</div>
      </div>}
      <ActionList
        sdkLanguage={sdkLanguage}
        actions={model?.actions || []}
        selectedAction={model ? selectedAction : undefined}
        selectedTime={selectedTime}
        setSelectedTime={setSelectedTime}
        onSelected={onActionSelected}
        onHighlighted={setHighlightedAction}
        revealAttachment={revealAttachment}
        revealConsole={revealConsole}
        isLive={isLive}
      />
    </div>
  };
  const metadataTab: TabbedPaneTabModel = {
    id: 'metadata',
    title: 'Metadata',
    component: <MetadataView model={model}/>
  };

  return <div className='vbox workbench' {...(inert ? { inert: 'true' } : {})}>
    {!hideTimeline && <Timeline
      model={model}
      consoleEntries={consoleModel.entries}
      boundaries={boundaries}
      highlightedAction={highlightedAction}
      highlightedEntry={highlightedEntry}
      highlightedConsoleEntry={highlightedConsoleMessage}
      onSelected={onActionSelected}
      sdkLanguage={sdkLanguage}
      selectedTime={selectedTime}
      setSelectedTime={setSelectedTime}
    />}
    <SplitView
      sidebarSize={250}
      orientation={sidebarLocation === 'bottom' ? 'vertical' : 'horizontal'} settingName='propertiesSidebar'
      main={<SplitView
        sidebarSize={250}
        orientation='horizontal'
        sidebarIsFirst
        settingName='actionListSidebar'
        main={<SnapshotTabsView
          action={activeAction}
          model={model}
          sdkLanguage={sdkLanguage}
          testIdAttributeName={model?.testIdAttributeName || 'data-testid'}
          isInspecting={isInspecting}
          setIsInspecting={setIsInspecting}
          highlightedElement={highlightedElement}
          setHighlightedElement={elementPicked} />}
        sidebar={
          <TabbedPane
            tabs={[actionsTab, metadataTab]}
            selectedTab={selectedNavigatorTab}
            setSelectedTab={setSelectedNavigatorTab}
          />
        }
      />}
      sidebar={<TabbedPane
        tabs={tabs}
        selectedTab={selectedPropertiesTab}
        setSelectedTab={selectPropertiesTab}
        rightToolbar={[
          sidebarLocation === 'bottom' ?
            <ToolbarButton title='Dock to right' icon='layout-sidebar-right-off' onClick={() => {
              setSidebarLocation('right');
            }} /> :
            <ToolbarButton title='Dock to bottom' icon='layout-panel-off' onClick={() => {
              setSidebarLocation('bottom');
            }} />
        ]}
        mode={sidebarLocation === 'bottom' ? 'default' : 'select'}
      />}
    />
  </div>;
};
