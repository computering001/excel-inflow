#!/usr/bin/env python3
"""Native-Excel compatibility sentinels for emitted number formats."""

from emit.styles import StyleTable, build_differential, validate_number_format


def reject(value: str) -> None:
    try:
        validate_number_format(value)
    except ValueError as error:
        assert "at most four" in str(error)
        return
    raise AssertionError(f"native-incompatible format was accepted: {value}")


assert validate_number_format('0.0%;(0.0%);"–"') == '0.0%;(0.0%);"–"'
assert validate_number_format('0;0;0;"literal;semicolon"') == '0;0;0;"literal;semicolon"'
assert validate_number_format(r'0\;0;0;0') == r'0\;0;0;0'
reject('[=1]"Jan";[=2]"Feb";[=3]"Mar";[=4]"Apr";[=5]"May";00')

try:
    StyleTable([{"number_format": "0;0;0;0;0"}])
except ValueError:
    pass
else:
    raise AssertionError("cell-style path accepted a five-section format")

try:
    build_differential({"number_format": "0;0;0;0;0"})
except ValueError:
    pass
else:
    raise AssertionError("differential-style path accepted a five-section format")

print('{"status":"PASS","checks":6,"mutations_rejected":3}')
