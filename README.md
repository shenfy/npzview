# NPZ Viewer

A lightweight VS Code extension for viewing NumPy `.npy` and `.npz` files - displays variable names, shapes, and data types with zero dependencies beyond a single ZIP library.

## Features

- **Instant Preview** - Open any `.npy` or `.npz` file and see its contents immediately
- **Dual Format Support** - Handles both single array files (`.npy`) and multi-file archives (`.npz`)
- **Detailed Info** - Shows variable name, shape, and dtype for each array
- **Human-Readable Types** - Dtypes are translated (e.g., `<i4>` → `<i4> (int32, little-endian)`)
- **Endianness Display** - Shows little-endian, big-endian, or native byte order
- **Data Preview** - Click variable name to expand/collapse array data
- **Statistics** - Min, max, mean for numeric arrays (arrays up to 1M elements)
- **Standard Deviation** - For arrays ≤ 100 elements
- **First 100 Values** - Preview of array data as flat list or table
- **Minimal Dependencies** - Only requires `yauzl` for ZIP reading

## Installation

1. Install from VS Code Marketplace (search "NPZ Viewer")
2. Or install manually: download `.vsix` file and run "Extensions: Install from VSIX..."

## Usage

1. Open any `.npy` or `.npz` file in VS Code
2. The extension automatically displays a table with:
   - **Variable** - Name of array (or "array" for single `.npy` files)
   - **Shape** - Array dimensions (e.g., `[100, 28, 28]` or `[scalar]` for 0-dimensional arrays)
   - **Dtype** - Data type with human-readable explanation
3. **Click any variable name** to expand/collapse:
   - Statistics (min, max, mean, std dev) for numeric arrays
   - First 100 array values (formatted for readability)

## Supported Dtypes

Supports all NumPy dtypes:
- Integers: `int8`, `int16`, `int32`, `int64`
- Unsigned: `uint8`, `uint16`, `uint32`, `uint64`
- Floats: `float16`, `float32`, `float64`
- Boolean, complex, bytes, strings, unicode, void, objects

Shows endianness (little-endian, big-endian, native).

## Requirements

- VS Code 1.96.0 or higher
- No Python or NumPy installation required

## License

MIT License - see [LICENSE](LICENSE) for details.
