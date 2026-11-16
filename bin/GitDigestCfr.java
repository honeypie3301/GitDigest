import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.benf.cfr.reader.api.CfrDriver;
import org.benf.cfr.reader.api.ClassFileSource;
import org.benf.cfr.reader.api.OutputSinkFactory;
import org.benf.cfr.reader.api.SinkReturns;
import org.benf.cfr.reader.bytecode.analysis.parse.utils.Pair;

public final class GitDigestCfr {
    private static String encodedMapping = "";
    private static Path mappingFile;

    public static void main(String[] args) throws IOException {
        var input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        try {
            for (String line; (line = input.readLine()) != null;) {
                try {
                    String[] fields = line.split("\t", -1);
                    byte[] bytecode = Base64.getDecoder().decode(fields[0]);
                    String java = decompile(bytecode, fields[1].equals("-") ? encodedMapping : fields[1]);
                    if (java.length() > 4 * 1024 * 1024) throw new IOException("CFR output exceeds the per-class limit");
                    respond("ok", java);
                } catch (Exception | LinkageError | StackOverflowError error) {
                    respond("error", String.valueOf(error.getMessage()));
                }
            }
        } finally {
            if (mappingFile != null) Files.deleteIfExists(mappingFile);
        }
    }

    private static void respond(String status, String value) {
        System.out.println(status + "\t" + Base64.getEncoder().encodeToString(value.getBytes(StandardCharsets.UTF_8)));
        System.out.flush();
    }

    private static String decompile(byte[] bytecode, String mapping) throws IOException {
        Map<String, String> options = new HashMap<>();
        options.put("silent", "true");
        options.put("renameillegalidents", "true");
        if (!mapping.isEmpty()) {
            if (mappingFile == null) {
                mappingFile = Files.createTempFile("gitdigest-mapping-", ".txt");
                mappingFile.toFile().deleteOnExit();
            }
            if (!mapping.equals(encodedMapping)) {
                Files.write(mappingFile, Base64.getDecoder().decode(mapping));
                encodedMapping = mapping;
            }
            options.put("obfuscationpath", mappingFile.toString());
        }

        var java = new StringBuilder();
        var failure = new StringBuilder();
        var sinks = new OutputSinkFactory() {
            public List<SinkClass> getSupportedSinks(SinkType type, Collection<SinkClass> classes) {
                if (type == SinkType.JAVA) return List.of(SinkClass.DECOMPILED);
                if (type == SinkType.EXCEPTION) return List.of(SinkClass.EXCEPTION_MESSAGE);
                return List.of(SinkClass.STRING);
            }
            public <T> Sink<T> getSink(SinkType type, SinkClass sinkClass) {
                if (type == SinkType.JAVA) return value -> java.append(((SinkReturns.Decompiled) value).getJava());
                if (type == SinkType.EXCEPTION) return value -> failure.append(((SinkReturns.ExceptionMessage) value).getMessage());
                return value -> {};
            }
        };
        String inputPath = classPath(bytecode);
        new CfrDriver.Builder()
            .withClassFileSource(new InputClass(inputPath, bytecode))
            .withOptions(options)
            .withOutputSink(sinks)
            .build()
            .analyse(List.of(inputPath));
        if (java.length() == 0) throw new IOException(failure.length() == 0 ? "CFR returned no source" : failure.toString());
        return java.toString();
    }

    private static String classPath(byte[] bytes) throws IOException {
        var reader = new DataInputStream(new ByteArrayInputStream(bytes));
        reader.skipBytes(8);
        int count = reader.readUnsignedShort();
        var names = new String[count];
        var classes = new int[count];
        for (int i = 1; i < count; i++) {
            switch (reader.readUnsignedByte()) {
                case 1: names[i] = reader.readUTF(); break;
                case 7: classes[i] = reader.readUnsignedShort(); break;
                case 8: case 16: case 19: case 20: reader.skipBytes(2); break;
                case 15: reader.skipBytes(3); break;
                case 3: case 4: case 9: case 10: case 11: case 12: case 17: case 18:
                    reader.skipBytes(4); break;
                case 5: case 6: reader.skipBytes(8); i++; break;
                default: throw new IOException("Unknown constant-pool tag");
            }
        }
        reader.readUnsignedShort();
        String name = names[classes[reader.readUnsignedShort()]];
        if (name == null || name.isEmpty()) throw new IOException("Class has no name");
        return name + ".class";
    }

    private static final class InputClass implements ClassFileSource {
        private final String name;
        private final byte[] bytes;
        InputClass(String name, byte[] bytes) { this.name = name; this.bytes = bytes; }
        public void informAnalysisRelativePathDetail(String path, String jar) {}
        public Collection<String> addJar(String name) { return List.of(); }
        public String getPossiblyRenamedPath(String path) { return path; }
        public Pair<byte[], String> getClassFileContent(String path) throws IOException {
            if (path.equals(name)) return Pair.make(bytes, path);
            // Resolve JDK types without letting a supplied class read from the host filesystem.
            if (path.startsWith("java/") || path.startsWith("javax/")) {
                if (!path.contains("..") && !path.contains("\\")) {
                    try (InputStream input = ClassLoader.getPlatformClassLoader().getResourceAsStream(path)) {
                        if (input != null) return Pair.make(input.readAllBytes(), path);
                    }
                }
            }
            throw new IOException("Class dependency unavailable: " + path);
        }
    }
}
