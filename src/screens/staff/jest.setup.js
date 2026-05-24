// jest.setup.js — global test setup for imr-staff.

// Mock AsyncStorage with the official mock module.
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    setItem: jest.fn(() => Promise.resolve()),
    getItem: jest.fn(() => Promise.resolve(null)),
    removeItem: jest.fn(() => Promise.resolve()),
    clear: jest.fn(() => Promise.resolve()),
    getAllKeys: jest.fn(() => Promise.resolve([])),
    multiGet: jest.fn(() => Promise.resolve([])),
    multiSet: jest.fn(() => Promise.resolve()),
    multiRemove: jest.fn(() => Promise.resolve()),
  },
}));

// Mock NetInfo (used by useConnectionStatus on native).
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    addEventListener: jest.fn(() => () => {}),
    fetch: jest.fn(() =>
      Promise.resolve({ isConnected: true, isInternetReachable: true }),
    ),
  },
}));

// Mock react-native-toast-message — render-free during tests.
jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: {
    show: jest.fn(),
    hide: jest.fn(),
  },
}));

// Mock react-native-safe-area-context — return a plain provider in tests.
jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  return {
    SafeAreaProvider: ({ children }) =>
      React.createElement(React.Fragment, null, children),
    SafeAreaView: ({ children, ...props }) =>
      React.createElement('SafeAreaView', props, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

// Stable uuid for deterministic test snapshots.
global.crypto = global.crypto || {};
let uuidCounter = 0;
global.crypto.randomUUID = jest.fn(() => {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`;
});

// (RN 0.81 removed the legacy NativeAnimatedHelper path; jest no
// longer needs to mock it. Animated warnings in tests are tolerated.)

// ─── RN 0.81 jest-mock compat patch ─────────────────────────────
// RN 0.81 ships function-component Text/View (via the new `component(...)`
// declaration). The upstream `mockComponent` helper at
// node_modules/react-native/jest/mockComponent.js:42 dereferences
// `RealComponent.prototype.constructor`, which crashes on a function
// component because `prototype` is undefined. We replace the affected
// component mocks with light fragments so screen tests work.
jest.mock('react-native/Libraries/Text/Text', () => {
  const React = require('react');
  function Text({ children, ...rest }) {
    return React.createElement('Text', rest, children);
  }
  return { __esModule: true, default: Text };
});
jest.mock('react-native/Libraries/Components/View/View', () => {
  const React = require('react');
  function View({ children, ...rest }) {
    return React.createElement('View', rest, children);
  }
  return { __esModule: true, default: View };
});
jest.mock('react-native/Libraries/Components/TextInput/TextInput', () => {
  const React = require('react');
  const TextInput = React.forwardRef(({ onChangeText, value, ...rest }, ref) =>
    React.createElement('TextInput', {
      ...rest,
      ref,
      value: value ?? '',
      onChange: (e) => {
        if (typeof onChangeText === 'function') {
          const v = e?.target?.value ?? e?.nativeEvent?.text ?? '';
          onChangeText(v);
        }
      },
      // also expose onChangeText so fireEvent.changeText works
      onChangeText,
    }),
  );
  return { __esModule: true, default: TextInput };
});
jest.mock('react-native/Libraries/Components/ActivityIndicator/ActivityIndicator', () => {
  const React = require('react');
  function ActivityIndicator(props) {
    return React.createElement('ActivityIndicator', props);
  }
  return { __esModule: true, default: ActivityIndicator };
});
jest.mock('react-native/Libraries/Lists/FlatList', () => {
  const React = require('react');
  function FlatList({ data, keyExtractor, renderItem, ...rest }) {
    return React.createElement(
      'FlatList',
      rest,
      (data || []).map((item, index) =>
        React.createElement(
          'FlatListItem',
          { key: keyExtractor ? keyExtractor(item, index) : index },
          renderItem({ item, index }),
        ),
      ),
    );
  }
  return { __esModule: true, default: FlatList };
});
jest.mock('react-native/Libraries/Components/Pressable/Pressable', () => {
  const React = require('react');
  function Pressable({ children, onPress, disabled, style, testID, ...rest }) {
    const resolvedStyle = typeof style === 'function' ? style({ pressed: false }) : style;
    return React.createElement(
      'Pressable',
      {
        ...rest,
        testID,
        style: resolvedStyle,
        onClick: !disabled && onPress ? onPress : undefined,
        onPress: !disabled ? onPress : undefined,
        disabled,
      },
      typeof children === 'function' ? children({ pressed: false }) : children,
    );
  }
  return { __esModule: true, default: Pressable };
});
