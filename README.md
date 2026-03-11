# NPZ Viewer

A lightweight VS Code extension for viewing NumPy `.npz` files - displays variable names, shapes, and data types with zero dependencies beyond a single ZIP library.

## Features

- **Instant Preview** - Open any `.npz` file and see its contents immediately
- **Detailed Info** - Shows variable name, shape, and dtype for each array
- **Human-Readable Types** - Dtypes are translated (e.g., `<i4>` → `<i4> (int32, little-endian)`)
- **Minimal Dependencies** - Only requires `adm-zip` (~50KB)

## Installation

1. Install from VS Code Marketplace (search "NPZ Viewer")
2. Or install manually: download the `.vsix` file and run "Extensions: Install from VSIX..."

## Usage

1. Open any `.npz` file in VS Code
2. The extension automatically displays a table with:
   - **Variable** - Name of the array
   - **Shape** - Array dimensions (e.g., `[100, 28, 28]`)
   - **Dtype** - Data type with human-readable explanation

## Supported Dtypes

Supports all NumPy dtypes:
- Integers: `int8`, `int16`, `int32`, `int64`
- Unsigned: `uint8`, `uint16`, `uint32`, `uint64`
- Floats: `float16`, `float32`, `float64`
- Complex, bytes, strings, unicode, void, objects

Shows endianness (little-endian, big-endian, native).

## Requirements

- VS Code 1.96.0 or higher
- No Python or NumPy installation required

## License

MIT License - see [LICENSE](LICENSE) for details.
