import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import ghidra.program.model.mem.*;
import ghidra.program.model.address.*;
import ghidra.program.model.data.*;
import ghidra.program.util.DefinedStringIterator;
import java.io.*;
import java.util.*;

public class DumpAll extends GhidraScript {
  public void run() throws Exception {
    String out = getScriptArgs()[0];
    String tag = currentProgram.getName();
    PrintWriter info = new PrintWriter(new FileWriter(out + "/" + tag + ".info.txt"));
    info.println("Language: " + currentProgram.getLanguageID() + " Compiler: " + currentProgram.getCompilerSpec().getCompilerSpecID());
    info.println("ImageBase: " + currentProgram.getImageBase());
    for (MemoryBlock b : currentProgram.getMemory().getBlocks())
      info.println("Block " + b.getName() + " " + b.getStart() + "-" + b.getEnd() + " " + (b.isRead()?"r":"-")+(b.isWrite()?"w":"-")+(b.isExecute()?"x":"-"));
    SymbolTable st = currentProgram.getSymbolTable();
    info.println("== Entry points");
    AddressIterator ai = st.getExternalEntryPointIterator();
    while (ai.hasNext()) { Address a = ai.next(); info.println(a + " " + getSymbolAt(a)); }
    info.println("== Imports");
    for (Symbol s : st.getExternalSymbols()) {
      info.print(s.getParentNamespace().getName() + "!" + s.getName());
      Reference[] refs = getReferencesTo(s.getAddress());
      info.print("  refs=" + refs.length);
      ExternalLocation el = currentProgram.getExternalManager().getExternalLocation(s);
      info.println();
    }
    info.close();

    PrintWriter strs = new PrintWriter(new FileWriter(out + "/" + tag + ".strings.txt"));
    for (Data d : DefinedStringIterator.forProgram(currentProgram)) {
      Object v = d.getValue();
      StringBuilder fs = new StringBuilder();
      for (Reference r : getReferencesTo(d.getAddress())) {
        Function f = getFunctionContaining(r.getFromAddress());
        fs.append(" ").append(f == null ? r.getFromAddress().toString() : f.getName());
      }
      strs.println(d.getAddress() + "\t" + String.valueOf(v).replace("\n","\n").replace("\r","\r") + "\t<-" + fs);
    }
    strs.close();

    DecompInterface di = new DecompInterface();
    di.openProgram(currentProgram);
    PrintWriter fl = new PrintWriter(new FileWriter(out + "/" + tag + ".functions.txt"));
    PrintWriter dc = new PrintWriter(new FileWriter(out + "/" + tag + ".decomp.c"));
    for (Function f : currentProgram.getFunctionManager().getFunctions(true)) {
      if (f.isThunk() || f.isExternal()) continue;
      StringBuilder callees = new StringBuilder();
      for (Function c : f.getCalledFunctions(monitor)) callees.append(c.getName()).append(",");
      fl.println(f.getEntryPoint() + "\t" + f.getBody().getNumAddresses() + "\t" + f.getName() + "\tcallers=" + f.getCallingFunctions(monitor).size() + "\tcallees=" + callees);
      DecompileResults r = di.decompileFunction(f, 60, monitor);
      dc.println("// ==== " + f.getName() + " @ " + f.getEntryPoint());
      if (r != null && r.decompileCompleted()) dc.println(r.getDecompiledFunction().getC());
      else dc.println("// decompile failed");
    }
    fl.close(); dc.close();
  }
}
