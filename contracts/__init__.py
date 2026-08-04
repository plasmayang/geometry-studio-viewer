"""geometry-studio-viewer data contracts.

This package defines the **canonical, versioned** data contracts that the
viewer expects from external data sources (kernel-app Gallery outputs,
mock fixtures, future protocol-mode payloads).

Contract version policy:
    - Each contract is a Python module named `<resource>_v<N>.py`.
    - Every validator function raises `ContractError` on failure.
    - Passing the validator == satisfying the contract.
    - The viewer trusts JSON iff a validator passes (CI gate enforced
      upstream by the data producer).

Public entry points:
    validate_manifest_v1(data)  -> None
    validate_case_v1(data)      -> None
    validate(path)              -> None      (dispatches by top-level
                                              "schema_version" field)

CLI:
    python -m contracts validate <file>      (single file)
    python -m contracts validate-dir <dir>   (manifest + all referenced cases)

The viewer consumes this contract by:
    - invoking the CI-validated output as a hard signal (no re-validation
      in the browser by default), OR
    - re-validating in the browser via a future WASM build of the same
      Python source (not implemented yet).
"""

from ._errors import ContractError
from .manifest_v1 import validate_manifest_v1, MANIFEST_V1
from .case_v1 import validate_case_v1, CASE_V1

__all__ = [
    "ContractError",
    "validate_manifest_v1",
    "validate_case_v1",
    "MANIFEST_V1",
    "CASE_V1",
]

# Schema version that this contract package implements.
PACKAGE_VERSION = "1.0"