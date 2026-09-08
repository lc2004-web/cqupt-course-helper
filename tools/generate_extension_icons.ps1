Add-Type -AssemblyName System.Drawing

$outputDirectory = Join-Path $PSScriptRoot '..\outputs\cqupt-course-helper-extension'
$sizes = @(16, 32, 48, 128)

foreach ($size in $sizes) {
    $bitmap = [System.Drawing.Bitmap]::new($size, $size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([System.Drawing.Color]::FromArgb(37, 99, 235))

    $whitePenWidth = [Math]::Max(2, [int]($size * 0.09))
    $whitePen = [System.Drawing.Pen]::new([System.Drawing.Color]::White, $whitePenWidth)
    $whitePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $whitePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $greenPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(22, 163, 74), $whitePenWidth)
    $greenPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $greenPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

    $graphics.DrawLine($whitePen, $size * 0.20, $size * 0.30, $size * 0.77, $size * 0.30)
    $graphics.DrawLine($whitePen, $size * 0.20, $size * 0.50, $size * 0.58, $size * 0.50)
    $graphics.FillEllipse([System.Drawing.Brushes]::White, $size * 0.53, $size * 0.52, $size * 0.36, $size * 0.36)
    $graphics.DrawLine($greenPen, $size * 0.61, $size * 0.70, $size * 0.68, $size * 0.77)
    $graphics.DrawLine($greenPen, $size * 0.68, $size * 0.77, $size * 0.82, $size * 0.61)

    $path = Join-Path $outputDirectory "icon-$size.png"
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $greenPen.Dispose()
    $whitePen.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
}
