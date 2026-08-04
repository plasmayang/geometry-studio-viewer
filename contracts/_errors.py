"""ContractError and small shared types."""


class ContractError(ValueError):
    """Raised by any validator when input fails to satisfy the contract.

    The error message is intended for humans (CI logs, developer console)
    and for tooling (stable machine-readable `code` attribute).
    """

    def __init__(self, message: str, *, code: str = "CONTRACT_VIOLATION",
                 path: str = ""):
        super().__init__(message if not path else f"{path}: {message}")
        self.code = code
        self.path = path

    @classmethod
    def at(cls, path: str, message: str, code: str = "CONTRACT_VIOLATION") -> "ContractError":
        return cls(message, code=code, path=path)