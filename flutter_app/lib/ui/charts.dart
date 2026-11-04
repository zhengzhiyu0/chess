import 'dart:math';

import 'package:flutter/material.dart';

class LineChart extends StatelessWidget {
  const LineChart({
    super.key,
    required this.values,
    this.color = const Color(0xffa7cd8f),
    this.center,
    this.onSelect,
    this.selected,
  });
  final List<double> values;
  final Color color;
  final double? center;
  final ValueChanged<int>? onSelect;
  final int? selected;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, size) {
      return GestureDetector(
        onTapDown: onSelect == null
            ? null
            : (e) => onSelect!(
                (e.localPosition.dx / size.maxWidth * max(0, values.length - 1))
                    .round()
                    .clamp(0, max(0, values.length - 1)),
              ),
        child: CustomPaint(
          size: Size(size.maxWidth, size.maxHeight),
          painter: _LinePainter(
            values,
            color,
            center,
            selected,
            Theme.of(context).colorScheme.outlineVariant,
          ),
        ),
      );
    },
  );
}

class _LinePainter extends CustomPainter {
  _LinePainter(
    this.values,
    this.color,
    this.center,
    this.selected,
    this.lineColor,
  );
  final List<double> values;
  final Color color, lineColor;
  final double? center;
  final int? selected;
  @override
  void paint(Canvas canvas, Size size) {
    final grid = Paint()
      ..color = lineColor.withValues(alpha: 0.4)
      ..strokeWidth = 1;
    for (var i = 1; i < 4; i++) {
      canvas.drawLine(
        Offset(0, size.height * i / 4),
        Offset(size.width, size.height * i / 4),
        grid,
      );
    }
    if (values.isEmpty) return;
    var lo = values.reduce(min), hi = values.reduce(max);
    if (center != null) {
      lo = 0;
      hi = 100;
    }
    if (hi - lo < 50) {
      lo -= 25;
      hi += 25;
    }
    Offset point(int i) => Offset(
      values.length == 1
          ? size.width / 2
          : i * size.width / (values.length - 1),
      size.height - 8 - (values[i] - lo) / (hi - lo) * (size.height - 16),
    );
    final path = Path()..moveTo(point(0).dx, point(0).dy);
    for (var i = 1; i < values.length; i++) {
      path.lineTo(point(i).dx, point(i).dy);
    }
    final fill = Path.from(path)
      ..lineTo(size.width, size.height)
      ..lineTo(0, size.height)
      ..close();
    canvas.drawPath(
      fill,
      Paint()
        ..shader = LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [color.withValues(alpha: 0.22), color.withValues(alpha: 0)],
        ).createShader(Offset.zero & size),
    );
    canvas.drawPath(
      path,
      Paint()
        ..color = color
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2.5
        ..strokeJoin = StrokeJoin.round,
    );
    if (selected != null && selected! >= 0 && selected! < values.length) {
      final p = point(selected!);
      canvas.drawLine(
        Offset(p.dx, 0),
        Offset(p.dx, size.height),
        grid..color = color.withValues(alpha: 0.5),
      );
      canvas.drawCircle(p, 4, Paint()..color = color);
    }
  }

  @override
  bool shouldRepaint(_LinePainter old) =>
      old.values != values || old.selected != selected || old.color != color;
}
