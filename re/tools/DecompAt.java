import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.app.cmd.disassemble.DisassembleCommand;
import ghidra.program.model.listing.*;
import ghidra.program.model.address.*;
import java.io.*;

/** Creates functions at the given addresses (if missing) and writes their decompilation.
 *  Args: <outfile> <addr> [addr...] */
public class DecompAt extends GhidraScript {
  public void run() throws Exception {
    String[] args = getScriptArgs();
    PrintWriter out = new PrintWriter(new FileWriter(args[0]));
    DecompInterface di = new DecompInterface();
    di.openProgram(currentProgram);
    for (int i = 1; i < args.length; i++) {
      Address a = toAddr(args[i]);
      Function f = getFunctionAt(a);
      if (f == null) {
        Function c = getFunctionContaining(a);
        if (c != null && !c.getEntryPoint().equals(a)) removeFunction(c);
        new DisassembleCommand(a, null, true).applyTo(currentProgram, monitor);
        f = createFunction(a, null);
      }
      if (f == null) { out.println("// ==== FAILED " + a); continue; }
      DecompileResults r = di.decompileFunction(f, 120, monitor);
      out.println("// ==== " + f.getName() + " @ " + a + " body " + f.getBody().getMinAddress() + "-" + f.getBody().getMaxAddress());
      out.println(r.getDecompiledFunction() != null ? r.getDecompiledFunction().getC() : "// decompile failed: " + r.getErrorMessage());
    }
    out.close();
  }
}
