import 'package:flutter/material.dart';

// Keep these values aligned with web/src/style.css. Flutter is the native
// renderer now, but the visual language is still the existing app's language.
const accent = Color(0xff81b64c);
const chromeBackground = Color(0xff000000);
const chromePanel = Color(0xff151515);
const chromePanel3 = Color(0xff252525);
const chromeText = Color(0xffffffff);
const chromeText2 = Color(0xffc3c2c1);
const chromeMuted = Color(0xff8b8987);

ThemeData appTheme(Brightness brightness) {
  final dark = brightness == Brightness.dark;
  final scheme = ColorScheme.fromSeed(
    seedColor: accent,
    brightness: brightness,
    surface: dark ? chromePanel : const Color(0xffffffff),
    primary: dark ? accent : const Color(0xff5d9632),
  );
  final base = ThemeData(
    colorScheme: scheme,
    useMaterial3: false,
    brightness: brightness,
    scaffoldBackgroundColor: dark
        ? chromeBackground
        : const Color(0xfff5f6f7),
    fontFamily: 'NotoSansSC',
    fontFamilyFallback: const ['NotoSansSymbols2', 'NotoEmoji'],
    visualDensity: VisualDensity.compact,
  );
  return base.copyWith(
    appBarTheme: AppBarTheme(
      backgroundColor: dark ? chromeBackground : const Color(0xfff5f6f7),
      surfaceTintColor: Colors.transparent,
      centerTitle: false,
      elevation: 0,
      titleTextStyle: base.textTheme.titleMedium?.copyWith(
        fontWeight: FontWeight.w700,
        letterSpacing: 0.4,
      ),
    ),
    cardTheme: CardThemeData(
      elevation: 0,
      color: dark ? chromePanel : scheme.surface,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: dark ? Colors.transparent : scheme.outlineVariant.withValues(alpha: 0.5)),
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: const Size(44, 40),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        textStyle: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        minimumSize: const Size(44, 38),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: scheme.surfaceContainerHighest.withValues(alpha: 0.4),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: BorderSide.none,
      ),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
    ),
    dividerTheme: DividerThemeData(
      color: scheme.outlineVariant.withValues(alpha: 0.5),
    ),
    navigationBarTheme: const NavigationBarThemeData(
      height: 68,
      elevation: 0,
      labelBehavior: NavigationDestinationLabelBehavior.alwaysShow,
    ),
    sliderTheme: SliderThemeData(
      trackHeight: 5,
      overlayShape: const RoundSliderOverlayShape(overlayRadius: 18),
    ),
  );
}
