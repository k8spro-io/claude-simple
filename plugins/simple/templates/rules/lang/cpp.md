---
paths:
  - "**/*.c"
  - "**/*.cc"
  - "**/*.cpp"
  - "**/*.h"
  - "**/*.hpp"
  - "**/CMakeLists.txt"
---
# C / C++

## Navigation
- Map a file: `rg -nE '^[A-Za-z_].*\(|^(class|struct|namespace|template)' src/thing.cpp`.
- The header tells you the contract; read the `.h` before the `.cpp`, and read neither whole.
- NEVER read `build/`, `cmake-build-*/`, `third_party/`, generated protobuf output.

## Memory and lifetime
- Ownership is explicit: `unique_ptr` by default, `shared_ptr` only when ownership is genuinely shared, raw pointers only as non-owning observers. A raw `new` in new code needs a reason.
- **A reference or pointer into a container is invalidated by the container's own growth.** `push_back` invalidates iterators and references into a `vector`; a captured reference to an element is a use-after-free waiting for load.
- A lambda capturing by reference `[&]` that outlives the frame is a dangling capture — the most common async bug in modern C++.
- `std::string_view` / `span` do not own. Never return one that points at a temporary.

## Undefined behaviour is not a theoretical concern
- Signed overflow, reading an uninitialised value, strict-aliasing violations and out-of-bounds access let the optimiser delete your checks. A bounds check written *after* the dereference is removed by the compiler.
- Every array index from an external input is validated before use. `memcpy` with a length from the wire is the classic remote vulnerability.

## Concurrency
- Data shared between threads is protected by a mutex or is atomic. "It is only an int" is a data race.
- Lock ordering is documented and global; two locks taken in two orders deadlock eventually.
- `std::thread` that is neither joined nor detached terminates the process in its destructor.

## Build and tests
- Build with warnings on and fatal (`-Wall -Wextra -Werror`), and run the test suite under sanitizers (`-fsanitize=address,undefined`) at least in CI. A sanitizer run finds in seconds what a review never finds.
- A test that never ran red proves nothing.

## Local gate
- Configure and build the project's own way (`cmake --build build`), run `ctest` on the touched targets, `clang-format` on the touched files, `clang-tidy` if the repo pins a config.
