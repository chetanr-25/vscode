/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore, toDisposable, IDisposable, Disposable } from '../common/lifecycle.js';
import { autorun, IObservable } from '../common/observable.js';
import { isFirefox } from './browser.js';
import { getWindows, sharedMutationObserver } from './dom.js';
import { mainWindow } from './window.js';

const globalStylesheets = new Map<HTMLStyleElement, Set<HTMLStyleElement>>();

export function isGlobalStylesheet(node: Node): boolean {
	return globalStylesheets.has(node as HTMLStyleElement);
}

class WrappedStyleElement extends Disposable {
	private _currentCssStyle = '';
	private _styleSheet: HTMLStyleElement | undefined;

	setStyle(cssStyle: string): void {
		if (cssStyle === this._currentCssStyle) {
			return;
		}

		this._currentCssStyle = cssStyle;

		if (!this._styleSheet) {
			this._styleSheet = createStyleSheet(
				mainWindow.document.head,
				s => s.textContent = cssStyle,
				this._store
			);
		} else {
			this._styleSheet.textContent = cssStyle;
		}
	}

	override dispose(): void {
		super.dispose();
		this._styleSheet = undefined;
	}
}

export function createStyleSheet(
	container: HTMLElement = mainWindow.document.head,
	beforeAppend?: (style: HTMLStyleElement) => void,
	disposableStore?: DisposableStore
): HTMLStyleElement {
	const style = document.createElement('style');
	style.type = 'text/css';
	style.media = 'screen';

	beforeAppend?.(style);
	container.appendChild(style);

	if (disposableStore) {
		disposableStore.add(toDisposable(() => style.remove()));
	}

	if (container === mainWindow.document.head) {
		const clones = new Set<HTMLStyleElement>();
		globalStylesheets.set(style, clones);

		disposableStore?.add(toDisposable(() => globalStylesheets.delete(style)));

		for (const { window: targetWindow, disposables } of getWindows()) {
			if (targetWindow === mainWindow) {
				continue;
			}

			const cloneDisposable = disposables.add(
				cloneGlobalStyleSheet(style, clones, targetWindow)
			);
			disposableStore?.add(cloneDisposable);
		}
	}

	return style;
}

export function cloneGlobalStylesheets(targetWindow: Window): IDisposable {
	const disposables = new DisposableStore();

	for (const [style, clones] of globalStylesheets) {
		disposables.add(cloneGlobalStyleSheet(style, clones, targetWindow));
	}

	return disposables;
}

function cloneGlobalStyleSheet(
	globalStylesheet: HTMLStyleElement,
	globalStylesheetClones: Set<HTMLStyleElement>,
	targetWindow: Window
): IDisposable {
	const disposables = new DisposableStore();

	const clone = globalStylesheet.cloneNode(true) as HTMLStyleElement;
	targetWindow.document.head.appendChild(clone);
	disposables.add(toDisposable(() => clone.remove()));

	const rules = globalStylesheet.sheet?.cssRules;
	if (rules) {
		for (const rule of rules) {
			clone.sheet?.insertRule(rule.cssText, clone.sheet.cssRules.length);
		}
	}

	disposables.add(
		sharedMutationObserver.observe(
			globalStylesheet,
			disposables,
			{ childList: true, subtree: isFirefox, characterData: isFirefox }
		)(() => {
			clone.textContent = globalStylesheet.textContent;
		})
	);

	globalStylesheetClones.add(clone);
	disposables.add(toDisposable(() => globalStylesheetClones.delete(clone)));

	return disposables;
}

let _sharedStyleSheet: HTMLStyleElement | null = null;
function getSharedStyleSheet(): HTMLStyleElement {
	if (!_sharedStyleSheet) {
		_sharedStyleSheet = createStyleSheet();
	}
	return _sharedStyleSheet;
}

export function createCSSRule(
	selector: string,
	cssText: string,
	style = getSharedStyleSheet()
): void {
	if (!cssText) {
		return;
	}

	style.sheet?.insertRule(`${selector} {${cssText}}`, 0);

	for (const cloned of globalStylesheets.get(style) ?? []) {
		createCSSRule(selector, cssText, cloned);
	}
}

export function removeCSSRulesContainingSelector(
	ruleName: string,
	style = getSharedStyleSheet()
): void {
	const rules = style.sheet?.cssRules;
	if (!rules) {
		return;
	}

	const toDelete: number[] = [];
	for (let i = 0; i < rules.length; i++) {
		const rule = rules[i];
		if (isCSSStyleRule(rule) && rule.selectorText.includes(ruleName)) {
			toDelete.push(i);
		}
	}

	for (let i = toDelete.length - 1; i >= 0; i--) {
		style.sheet?.deleteRule(toDelete[i]);
	}

	for (const cloned of globalStylesheets.get(style) ?? []) {
		removeCSSRulesContainingSelector(ruleName, cloned);
	}
}

function isCSSStyleRule(rule: CSSRule): rule is CSSStyleRule {
	return typeof (rule as CSSStyleRule).selectorText === 'string';
}

export function createStyleSheetFromObservable(css: IObservable<string>): IDisposable {
	const store = new DisposableStore();
	const wrapped = store.add(new WrappedStyleElement());

	store.add(autorun(reader => {
		wrapped.setStyle(css.read(reader));
	}));

	return store;
}
