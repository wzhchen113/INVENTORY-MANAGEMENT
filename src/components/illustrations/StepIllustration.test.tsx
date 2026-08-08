// src/components/illustrations/StepIllustration.test.tsx — Spec 154.
//
// Covers the surface-neutral drawing component: every art renders (AC-2), the
// registry and the model agree (AC-1/AC-2), labels come from the `labels` prop
// and never from a catalog (AC-6), colors come from the `palette` prop and
// never from a theme hook (AC-5), and the picture is decorative to a screen
// reader (AC-8).
//
// Nothing is mocked: the component imports no theme hook, no catalog and no
// store, which is exactly the property this suite exists to protect.
//
// NOTE on the queries: the illustration is deliberately hidden from assistive
// tech (AC-8), and RNTL v12 skips inaccessible subtrees by default — so every
// query here passes `{ includeHiddenElements: true }`. A query that starts
// failing without it means the a11y hiding was dropped.

import React from 'react';
import { render, screen } from '@testing-library/react-native';
import {
  INSTALL_ART_IDS,
  StepIllustration,
  type StepIllustrationLabels,
  type StepIllustrationPalette,
} from './StepIllustration';
import { installSteps, type InstallArt, type InstallPlatform } from '../../lib/installGuide';

const palette: StepIllustrationPalette = {
  frame: '#111111',
  screen: '#222222',
  chrome: '#333333',
  line: '#444444',
  border: '#555555',
  ink: '#666666',
  ink2: '#777777',
  highlight: '#888888',
  highlightBg: '#999999',
  highlightInk: '#aaaaaa',
};

const labels: StepIllustrationLabels = {
  appName: 'APP_NAME',
  addToHomeScreen: 'ADD_TO_HOME_SCREEN',
  add: 'ADD',
  installApp: 'INSTALL_APP',
  install: 'INSTALL',
};

/** The picture is aria-hidden by design; RNTL needs telling. */
const HIDDEN = { includeHiddenElements: true } as const;

function renderArt(art: InstallArt, width = 200) {
  return render(
    <StepIllustration
      testID={`art-${art}`}
      art={art}
      width={width}
      palette={palette}
      labels={labels}
    />,
  );
}

describe('StepIllustration — coverage (AC-1, AC-2)', () => {
  const PLATFORMS: InstallPlatform[] = ['ios', 'android', 'desktop'];

  test('the registry draws exactly the arts the model asks for', () => {
    const fromModel = PLATFORMS.flatMap((p) => installSteps(p).map((s) => s.art)).sort();
    expect([...INSTALL_ART_IDS].sort()).toEqual(fromModel);
  });

  test.each(INSTALL_ART_IDS)('%s renders without throwing', (art) => {
    expect(() => renderArt(art)).not.toThrow();
    expect(screen.getByTestId(`art-${art}`, HIDDEN)).toBeTruthy();
  });

  test.each([100, 160, 240, 400])('renders at width %i and keeps that width', (width) => {
    renderArt('ios-share-sheet', width);
    const node = screen.getByTestId('art-ios-share-sheet', HIDDEN);
    expect(node.props.style.width).toBe(width);
    // Height follows the art's aspect ratio, so it is proportional and > 0.
    expect(node.props.style.height).toBeGreaterThan(width);
  });
});

describe('StepIllustration — labels come from the prop (AC-6)', () => {
  test('the iOS share sheet draws the "Add to Home Screen" row label', () => {
    renderArt('ios-share-sheet');
    expect(screen.getByText('ADD_TO_HOME_SCREEN', HIDDEN)).toBeTruthy();
  });

  test('the iOS Add dialog draws the title, the app name and the Add button', () => {
    renderArt('ios-add-confirm');
    expect(screen.getByText('ADD_TO_HOME_SCREEN', HIDDEN)).toBeTruthy();
    expect(screen.getByText('APP_NAME', HIDDEN)).toBeTruthy();
    expect(screen.getByText('ADD', HIDDEN)).toBeTruthy();
  });

  test('the Android menu draws the "Install app" row label', () => {
    renderArt('android-menu');
    expect(screen.getByText('INSTALL_APP', HIDDEN)).toBeTruthy();
  });

  test('the Android dialog draws the app name and the Install button', () => {
    renderArt('android-confirm');
    expect(screen.getByText('APP_NAME', HIDDEN)).toBeTruthy();
    expect(screen.getByText('INSTALL', HIDDEN)).toBeTruthy();
  });

  test('the desktop dialog draws the title, the app name and the Install button', () => {
    renderArt('desktop-confirm');
    expect(screen.getByText('INSTALL_APP', HIDDEN)).toBeTruthy();
    expect(screen.getByText('APP_NAME', HIDDEN)).toBeTruthy();
    expect(screen.getByText('INSTALL', HIDDEN)).toBeTruthy();
  });

  test('labels clip rather than wrap, so a long localization cannot break the frame', () => {
    renderArt('android-menu');
    const label = screen.getByText('INSTALL_APP', HIDDEN);
    expect(label.props.numberOfLines).toBe(1);
    expect(label.props.ellipsizeMode).toBe('tail');
  });
});

describe('StepIllustration — palette + a11y (AC-5, AC-8)', () => {
  test('label color comes from the palette prop', () => {
    renderArt('android-confirm');
    // `install` is drawn ON the highlight fill → highlightInk.
    expect(screen.getByText('INSTALL', HIDDEN).props.style.color).toBe(palette.highlightInk);
    // `appName` sits on the dialog surface → ink.
    expect(screen.getByText('APP_NAME', HIDDEN).props.style.color).toBe(palette.ink);
  });

  test('label geometry scales with width (one shared scale factor)', () => {
    const small = render(
      <StepIllustration art="android-menu" width={124} palette={palette} labels={labels} />,
    );
    const sizeAt124 = small.getByText('INSTALL_APP', HIDDEN).props.style.fontSize;
    small.unmount();

    render(<StepIllustration art="android-menu" width={248} palette={palette} labels={labels} />);
    const sizeAt248 = screen.getByText('INSTALL_APP', HIDDEN).props.style.fontSize;

    expect(sizeAt248).toBeCloseTo(sizeAt124 * 2, 5);
  });

  test('the picture is decorative — hidden from assistive tech, no label of its own', () => {
    renderArt('ios-share');
    const node = screen.getByTestId('art-ios-share', HIDDEN);
    expect(node.props.accessible).toBe(false);
    expect(node.props.accessibilityElementsHidden).toBe(true);
    expect(node.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(node.props.accessibilityLabel).toBeUndefined();
  });
});
