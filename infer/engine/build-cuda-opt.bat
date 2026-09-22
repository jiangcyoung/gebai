@echo off
REM build-cuda-opt.bat -- aggressive build: MSVC 14.44 (VS2022 toolset) + LTO + native ISA
REM Purpose: squeeze compile-time gains on top of the already-working CUDA build.
REM Notes: no --use_fast_math (changes FP results; requires separate consistency check).
REM        CMake Release already passes -O3; do NOT add CUDA host-compiler optimize flags here
REM        (they collide with try-compile Debug flags: "/RTC1" vs "/O2" -> D8016).
setlocal
set VCVARS="C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat"
set SRC=C:\Users\Administrator\code\gebai\infer\engine\llama.cpp-b11100
set BUILD=%SRC%\build-cuda-opt
set NINJA=C:\Users\Administrator\AppData\Local\Programs\Python\Python312\Scripts
set CUDA=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.9

call %VCVARS% -vcvars_ver=14.44 >nul 2>&1
if errorlevel 1 ( echo VCVARS_FAILED & exit /b 1 )
set PATH=%NINJA%;%CUDA%\bin;%PATH%

cd /d "%SRC%" || exit /b 1

echo === configure (optimized) ===
cmake -B "%BUILD%" -G Ninja ^
  -DCMAKE_BUILD_TYPE=Release ^
  -DGGML_CUDA=ON ^
  -DCMAKE_CUDA_ARCHITECTURES=89 ^
  -DCMAKE_CUDA_COMPILER="%CUDA%\bin\nvcc.exe" ^
  -DGGML_NATIVE=ON ^
  -DGGML_LTO=ON ^
  -DGGML_CUDA_GRAPHS=ON ^
  -DLLAMA_CURL=OFF ^
  -DLLAMA_BUILD_TESTS=OFF ^
  -DLLAMA_BUILD_EXAMPLES=ON ^
  -DLLAMA_BUILD_SERVER=ON
if errorlevel 1 ( echo CONFIGURE_FAILED & exit /b 1 )

echo.
echo === build ===
cmake --build "%BUILD%" -j 16
if errorlevel 1 ( echo BUILD_FAILED & exit /b 1 )

echo.
echo === artifacts ===
dir "%BUILD%\bin\llama-bench.exe" "%BUILD%\bin\llama-server.exe" 2>nul
echo BUILD_OPT_DONE
